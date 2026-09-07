/**
 * Stripchat Mouflon 密钥存储与 Worker 自动同步
 * 移植自 StripchatRecorder 的 MouflonKeysStore + sync_mouflon_keys_from_worker
 *
 * 密钥来源分两层:
 * 1. 手动配置 (settings.stripchatMouflonKeys, pkey=pdkey 多行文本)
 * 2. Worker 自动同步 (settings.stripchatMouflonSyncUrl, 默认 https://mouflon.chantrail.com)
 *
 * 合并策略: 手动密钥优先, Worker 密钥仅补充不覆盖手动密钥。
 * 持久化: 自动同步的密钥存储到 data/mouflon_keys.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, loadSettings } from '../config.js';
import { parseMouflonKeys, syncMouflonKeysFromWorker } from './api.js';

interface MouflonStore {
  keys: Record<string, string>;
  /** 最近一次 Worker 自动同步的密钥更新时间 (Worker 返回的 updated_at, RFC 3339) */
  autoSyncedAt: string | null;
  /** 最近一次手动修改密钥的时间 (RFC 3339) —— 对应 StripchatRecorder MouflonKeysStore.manual_updated_at */
  manualUpdatedAt: string | null;
}

let cachedStore: MouflonStore | null = null;

/** 最近一次同步结果 (内存中记录, 供前端状态展示) */
let lastSyncAt: string | null = null;
let lastSyncError: string | null = null;

function storePath(): string {
  return path.join(PATHS.data, 'mouflon_keys.json');
}

function loadStore(): MouflonStore {
  if (cachedStore) return cachedStore;
  try {
    if (fs.existsSync(storePath())) {
      const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as {
        keys?: Record<string, string>;
        auto_synced_at?: string | null;
        manual_updated_at?: string | null;
      };
      cachedStore = {
        keys: parsed.keys ?? {},
        autoSyncedAt: parsed.auto_synced_at ?? null,
        manualUpdatedAt: parsed.manual_updated_at ?? null,
      };
    } else {
      cachedStore = { keys: {}, autoSyncedAt: null, manualUpdatedAt: null };
    }
  } catch {
    cachedStore = { keys: {}, autoSyncedAt: null, manualUpdatedAt: null };
  }
  return cachedStore;
}

function saveStore(store: MouflonStore) {
  cachedStore = store;
  try {
    fs.writeFileSync(
      storePath(),
      JSON.stringify(
        {
          keys: store.keys,
          auto_synced_at: store.autoSyncedAt,
          manual_updated_at: store.manualUpdatedAt,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (e) {
    console.warn('[stripchat] 保存 Mouflon 密钥失败:', e instanceof Error ? e.message : e);
  }
}

/** 获取合并后的 Mouflon 密钥 (手动优先, Worker 补充) */
export function getMouflonKeys(): Record<string, string> {
  const settings = loadSettings();
  const manual = parseMouflonKeys(settings.stripchatMouflonKeys);
  const synced = loadStore().keys;
  return { ...synced, ...manual };
}

/**
 * 从 Worker 同步 Mouflon 密钥 (增量合并, 不覆盖手动密钥)
 * 返回是否有密钥变化。
 */
export async function syncMouflonKeys(): Promise<boolean> {
  const settings = loadSettings();
  const url = (settings.stripchatMouflonSyncUrl || '').trim();
  if (!url) return false;

  const result = await syncMouflonKeysFromWorker(
    url,
    settings.stripchatMouflonSyncToken || undefined,
  );
  if (!result) return false;

  const store = loadStore();

  // 时间戳相同: 仅补充缺失 key
  if (result.updatedAt && store.autoSyncedAt === result.updatedAt) {
    let changed = false;
    for (const [k, v] of Object.entries(result.keys)) {
      if (!(k in store.keys)) {
        store.keys[k] = v;
        changed = true;
      }
    }
    if (!changed) return false;
    saveStore(store);
    console.log(`[stripchat] Mouflon 密钥已补充 ${Object.keys(result.keys).length} 条 (updated_at 未变)`);
    return true;
  }

  // 时间戳不同: 增量合并
  const merged: Record<string, string> = { ...store.keys };
  for (const [k, v] of Object.entries(result.keys)) {
    if (!(k in merged)) merged[k] = v;
  }
  const next: MouflonStore = {
    keys: merged,
    autoSyncedAt: result.updatedAt || store.autoSyncedAt,
    manualUpdatedAt: store.manualUpdatedAt,
  };
  saveStore(next);
  console.log(
    `[stripchat] Mouflon 密钥已同步, 当前共 ${Object.keys(merged).length} 条 (updated_at=${result.updatedAt})`,
  );
  return true;
}

/** 记录手动密钥变更时间 (保存设置中的 stripchatMouflonKeys 时调用) */
export function recordManualKeysChange() {
  const store = loadStore();
  store.manualUpdatedAt = new Date().toISOString();
  saveStore(store);
}

/**
 * 手动触发一次从 Worker 同步 (对应 StripchatRecorder sync_mouflon_keys 命令)。
 * 忽略定时间隔, 强制请求 Worker 并比对 updated_at; 记录同步结果供前端展示。
 */
export async function syncMouflonKeysNow(): Promise<{ updated: boolean }> {
  const settings = loadSettings();
  const url = (settings.stripchatMouflonSyncUrl || '').trim();
  if (!url) {
    throw new Error('未配置 Mouflon 密钥同步 Worker URL,请先在设置中填写');
  }
  lastSyncAt = new Date().toISOString();
  try {
    const updated = await syncMouflonKeys();
    lastSyncError = null;
    return { updated };
  } catch (e) {
    lastSyncError = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

/** 获取同步状态 (供前端展示; 对应 StripchatRecorder MouflonKeysStore 状态) */
export function getMouflonSyncState() {
  const settings = loadSettings();
  const store = loadStore();
  return {
    url: settings.stripchatMouflonSyncUrl || '',
    token: settings.stripchatMouflonSyncToken || '',
    keyCount: Object.keys(getMouflonKeys()).length,
    /** 最近一次 Worker 同步的密钥更新时间 (从未同步为 null) */
    autoSyncedAt: store.autoSyncedAt,
    /** 最近一次手动修改密钥时间 (从未修改为 null) */
    manualUpdatedAt: store.manualUpdatedAt,
    /** 最近一次手动/定时同步触发时间 */
    lastSyncAt,
    /** 最近一次同步错误 (无错误为 null) */
    lastSyncError,
  };
}
