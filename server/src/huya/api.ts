/**
 * 虎牙直播 API 层
 * 移植自 biliup crates/biliup/src/downloader/live/huya.rs
 *
 * 关键流程:
 * 1. fetchRoomPage     — 抓取房间页 (HTML 实体解码)
 * 2. getRoomProfile    — 解析 TT_ROOM_DATA (state) 与 hyPlayerConfig.stream
 *                        (vMultiStreamInfo / gameLiveInfo / gameStreamInfoList)
 * 3. getCdnTokenInfoEx — WUP 接口获取防盗链 fm 参数 (主/备用端点随机)
 * 4. buildAnticode     — 用 MD5 链重建 wsSecret (含 fm base64 前缀与 wsTime 续期)
 */
import { createHash } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import {
  WUP_MAIN_URL,
  WUP_YST_URL,
  decodeGetCdnTokenEx,
  encodeGetCdnTokenEx,
  randomHyappUa,
} from './wup.js';
import type { HuyaBitrateInfo, HuyaRoomProfile, HuyaStreamInfo } from './types.js';

const HUYA_WEB_BASE_URL = 'https://www.huya.com';
const HUYA_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ---------------- 基础工具 ---------------- */

function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/** 解码虎牙页面中的 HTML 实体 */
export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** 从 JSON 对象取字符串字段, 缺失时报错 (对应 biliup json_str) */
export function jsonStr(value: unknown, key: string): string {
  if (value && typeof value === 'object') {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  throw new Error(`虎牙字段 ${key} 为空`);
}

function getObject(value: unknown, key: string): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    const v = (value as Record<string, unknown>)[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return null;
}

function getArray(value: unknown, key: string): unknown[] {
  if (value && typeof value === 'object') {
    const v = (value as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/* ---------------- 房间页抓取与解析 ---------------- */

/** 抓取房间页 (返回 HTML 实体解码后的文本; 页面不存在/被封禁时报错) */
export async function fetchRoomPage(roomId: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await undiciFetch(`${HUYA_WEB_BASE_URL}/${roomId}`, {
      headers: {
        referer: HUYA_WEB_BASE_URL,
        'user-agent': HUYA_USER_AGENT,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await resp.text();
    if (text.includes('找不到这个主播') || text.includes('该主播涉嫌违规，正在整改中')) {
      throw new Error('虎牙直播间不可用');
    }
    return decodeHtmlEntities(text);
  } finally {
    clearTimeout(timer);
  }
}

/** 提取 `pattern` 匹配位置之后到 `end` 字符之间的 JSON */
export function extractJsonAfter(page: string, pattern: string, end: string): unknown {
  const re = new RegExp(pattern);
  const mat = re.exec(page);
  if (!mat) throw new Error('虎牙房间数据不存在');
  const start = mat.index + mat[0].length;
  const endIdx = page.indexOf(end, start);
  if (endIdx < 0) throw new Error('虎牙房间数据不完整');
  try {
    return JSON.parse(page.slice(start, endIdx).trim()) as unknown;
  } catch (e) {
    throw new Error(`解析虎牙房间数据失败: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * 提取 `stream: { ... }` JSON 对象 (按括号配对定位结尾, 忽略字符串内括号)
 */
export function extractStreamJson(page: string): unknown {
  const marker = 'stream: ';
  const start = page.indexOf(marker);
  if (start < 0) throw new Error('虎牙流数据不存在');
  const end = findJsonValueEnd(page, start + marker.length);
  if (end === null) throw new Error('虎牙流数据不完整');
  try {
    return JSON.parse(page.slice(start + marker.length, end).trim()) as unknown;
  } catch (e) {
    throw new Error(`解析虎牙流数据失败: ${e instanceof Error ? e.message : e}`);
  }
}

/** 括号配对查找 JSON 值结尾 (返回结束位置的下一个下标) */
function findJsonValueEnd(input: string, start: number): number | null {
  let idx = start;
  while (idx < input.length && /\s/.test(input[idx])) idx += 1;
  const opening = input[idx];
  const closing = opening === '{' ? '}' : opening === '[' ? ']' : null;
  if (!closing) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let offset = 0; idx + offset < input.length; offset++) {
    const ch = input[idx + offset];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      if (depth === 0) return null;
      depth -= 1;
      if (depth === 0 && ch === closing) return idx + offset + 1;
    }
  }
  return null;
}

/**
 * 解析房间直播数据; 未开播/无流返回 null
 */
export async function getRoomProfile(roomId: string): Promise<HuyaRoomProfile | null> {
  const page = await fetchRoomPage(roomId);

  const roomData = extractJsonAfter(page, 'var\\s+TT_ROOM_DATA\\s*=\\s*', ';');
  const roomState =
    roomData && typeof roomData === 'object'
      ? String((roomData as Record<string, unknown>).state ?? '')
      : '';

  const stream = extractStreamJson(page);
  const bitrateInfo = getArray(stream, 'vMultiStreamInfo') as HuyaBitrateInfo[];
  if (roomState !== 'ON' || bitrateInfo.length === 0) return null;

  const data = getArray(stream, 'data')[0];
  if (!data) throw new Error('虎牙流数据为空');
  const liveInfo = getObject(data, 'gameLiveInfo');
  if (!liveInfo) throw new Error('虎牙直播信息为空');
  const streamInfo = getArray(data, 'gameStreamInfoList') as HuyaStreamInfo[];
  if (streamInfo.length === 0) return null;

  // TT_ROOM_DATA 不含主播昵称/头像; gameLiveInfo 内提供 nick / avatar180
  const roomRecord = (roomData ?? {}) as Record<string, unknown>;

  return {
    title: String(liveInfo.introduction ?? ''),
    cover: String(liveInfo.screenshot ?? '').replace('http://', 'https://'),
    maxBitrate: Number.isFinite(Number(liveInfo.bitRate)) ? Number(liveInfo.bitRate) : 0,
    bitrateInfo,
    streamInfo,
    owner: String(liveInfo.nick ?? roomRecord.nick ?? ''),
    avatar: String(liveInfo.avatar180 ?? roomRecord.avatar ?? '').replace(
      'http://',
      'https://',
    ),
  };
}

/* ---------------- 房间号解析 ---------------- */

/** 别名房间号 → 真实数字房间号 缓存 */
const realRidCache = new Map<string, string>();

/**
 * 解析房间号: URL 路径为纯数字直接使用;
 * 否则请求房间页取 TT_ROOM_DATA.profileRoom (结果进程内缓存)
 */
export async function resolveRoomId(inputUrl: string): Promise<string> {
  const path = inputUrl
    .split('huya.com/')[1]
    ?.split(/[?#]/)[0];
  if (!path) throw new Error('虎牙直播间地址错误');
  if (/^\d+$/.test(path)) return path;

  const cached = realRidCache.get(path);
  if (cached) return cached;

  const page = await fetchRoomPage(path);
  const roomData = extractJsonAfter(page, 'var\\s+TT_ROOM_DATA\\s*=\\s*', ';');
  const raw =
    roomData && typeof roomData === 'object'
      ? (roomData as Record<string, unknown>).profileRoom
      : undefined;
  const rid =
    typeof raw === 'number' && Number.isFinite(raw)
      ? String(raw)
      : typeof raw === 'string'
        ? raw
        : '';
  if (!rid || rid === '0') throw new Error('找不到这个主播');

  realRidCache.set(path, rid);
  return rid;
}

/* ---------------- WUP 防盗链 token ---------------- */

/**
 * 请求 getCdnTokenInfoEx 获取防盗链 fm 参数 (随机选择主/备用 WUP 端点)
 */
export async function getCdnTokenInfoEx(streamName: string): Promise<string> {
  const ua = randomHyappUa();
  const payload = encodeGetCdnTokenEx(streamName, ua);
  const url = Math.random() < 0.5 ? WUP_YST_URL : WUP_MAIN_URL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let body: Buffer;
  try {
    const resp = await undiciFetch(url, {
      method: 'POST',
      body: payload,
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    body = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    throw new Error(
      `请求虎牙 getCdnTokenInfoEx 失败: ${e instanceof Error ? e.message : e}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const token = decodeGetCdnTokenEx(body);
  if (!token) throw new Error('解析虎牙 getCdnTokenInfoEx 响应失败');
  return token;
}

/* ---------------- 防盗链参数重建 ---------------- */

/** 表单查询串解析 (serde_urlencoded 语义: '+' 视为空格, %XX 解码) */
function parseFormQuery(input: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of input.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq) : part;
    const value = eq >= 0 ? part.slice(eq + 1) : '';
    result.set(decodeFormComponent(key), decodeFormComponent(value));
  }
  return result;
}

function decodeFormComponent(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** 对应 Rust urlencoding::decode: 仅解码 %XX (不处理 '+') */
function urlEncodingDecode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    throw new Error('解码虎牙 fm 参数失败');
  }
}

/** 对应 Rust urlencoding::encode: 保留 A-Za-z0-9-_.~, 其余百分号编码 */
function urlEncodingEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function rotl64(value: number): number {
  const low = value >>> 0; // 低 32 位 (ToUint32)
  const high = Math.floor(value / 0x100000000); // 高 32 位
  const rotated = ((low << 8) | (low >>> 24)) >>> 0;
  return rotated + high * 0x100000000;
}

function generateRandomUid(): number {
  if (Math.random() < 0.5) {
    return Number(`1234${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`);
  }
  return Number(`140000${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`);
}

/**
 * 用防盗链参数模板重建签名:
 * - 从模板中取 fm (base64 形如 {prefix}_{...}, prefix 参与 wsSecret 计算)
 * - seqid/wsSecret/wsTime 基于当前时间与主播 uid 重新生成
 * - wsTime 剩余不足 20 分钟时续期为 +24 小时
 */
export function buildAnticode(
  streamName: string,
  antiCode: string,
  presenterUid: number,
): string {
  const query = parseFormQuery(antiCode);
  const fmRaw = query.get('fm');
  if (fmRaw === undefined) return antiCode;

  const ctype = query.get('ctype') ?? 'huya_live';
  const platformId = query.get('t') ?? '100';
  const isWap = Number(platformId) === 103;
  const uid = presenterUid === 0 ? generateRandomUid() : presenterUid;

  const nowMs = Date.now();
  const nowSecs = Math.floor(nowMs / 1000);
  const seqId = uid + nowMs;
  const secretHash = md5Hex(`${seqId}|${ctype}|${platformId}`);
  const convertUid = rotl64(uid);

  const fmDecoded = urlEncodingDecode(fmRaw);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(fmDecoded)) {
    throw new Error('解码虎牙 fm base64 失败');
  }
  const secretPrefix =
    Buffer.from(fmDecoded, 'base64').toString('utf8').split('_')[0] ?? '';

  let wsTime = query.get('wsTime');
  if (wsTime === undefined) throw new Error('虎牙 wsTime 为空');
  if ((parseInt(wsTime, 16) || 0) < nowSecs + 20 * 60) {
    wsTime = (nowSecs + 24 * 60 * 60).toString(16);
  }

  // wap 平台(t=103)用原始 uid 参与 wsSecret 计算, 其余平台用 convertUid
  const calcUid = isWap ? uid : convertUid;
  const secretStr = `${secretPrefix}_${calcUid}_${streamName}_${secretHash}_${wsTime}`;
  const wsSecret = md5Hex(secretStr);

  const fsParam = query.get('fs') ?? 'bgct';
  const fmEncoded = urlEncodingEncode(fmRaw);
  const base = `wsSecret=${wsSecret}&wsTime=${wsTime}&seqid=${seqId}&ctype=${ctype}&ver=1&fs=${fsParam}&fm=${fmEncoded}&t=${platformId}`;

  if (isWap) {
    const wsTimeSecs = parseInt(wsTime, 16) || 0;
    const ct = Math.floor((wsTimeSecs + Math.random()) * 1000);
    const uuid = Math.floor((((ct % 10_000_000_000) + Math.random()) * 1e3) % 0xffffffff);
    return `${base}&uid=${uid}&uuid=${uuid}`;
  }
  return `${base}&u=${convertUid}`;
}
