/**
 * rclone 配置管理与连接状态服务
 *
 * - 根据 Web UI 提交的网盘类型 + 账号 + 密码,自动生成/更新
 *   rclone 配置文件(默认 /config/rclone/rclone.conf,权限 600)
 * - 内置连接状态检查(rclone lsd),供前端 rclone 卡片展示
 * - 账号等凭据在日志/错误信息中自动脱敏
 *
 * 安全约定:
 * - 密码经 `rclone obscure -`(stdin) 混淆后写入配置,不落明文、不经进程参数
 * - remote 名称 / 网盘路径 / 网盘类型均经过白名单/格式校验
 * - 所有 rclone 调用使用参数数组(spawn),不经过 shell
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadSettings } from '../config.js';
import { ensureDir } from '../utils.js';

/** 支持"账号+密码"登录的网盘(仅这些会出现在前端网盘类型弹窗) */
export interface RcloneProviderInfo {
  id: string;
  label: string;
}

const PROVIDERS: RcloneProviderInfo[] = [
  { id: 'pikpak', label: 'PikPak' },
  { id: 'mega', label: 'MEGA' },
];

export function listProviders(): RcloneProviderInfo[] {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
}

export function getProviderLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label || '';
}

export function isValidProvider(id: string): boolean {
  return PROVIDERS.some((p) => p.id === id);
}

/** remote 名称校验:字母/数字/下划线开头,仅含 [A-Za-z0-9_.-],防注入与路径穿越 */
export function isValidRemoteName(name: string): boolean {
  return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name);
}

/** 网盘目标路径校验:无控制字符、无 ".." 路径段、长度受限 */
export function isValidRemotePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..');
}

/** rclone 配置文件路径(容器内由环境变量注入) */
export function getRcloneConfigPath(): string {
  return process.env.RCLONE_CONFIG || '/config/rclone/rclone.conf';
}

/** 容器内 rclone 可执行文件路径 */
function getRcloneBin(): string {
  return loadSettings().rclonePath || '/usr/bin/rclone';
}

/* ============================ 凭据脱敏 ============================ */

/** 已登记的敏感值(网盘账号等),日志/错误输出中出现时替换为 *** */
const credentialValues = new Set<string>();

export function registerCredentialValue(v: string) {
  const t = (v || '').trim();
  if (t.length >= 3) credentialValues.add(t);
}

/** 从配置文件(重新)加载 user 值到脱敏名单 */
export function loadCredentialValuesFromConfig(configPath: string = getRcloneConfigPath()) {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*user\s*=\s*(.+)$/);
      if (m && m[1].trim()) registerCredentialValue(m[1]);
    }
  } catch {
    /* 配置不存在时忽略 */
  }
}

/** 将文本中的已知凭据值替换为 *** */
export function sanitizeRcloneText(text: string): string {
  let out = text;
  for (const v of credentialValues) {
    if (v && out.includes(v)) out = out.split(v).join('***');
  }
  return out;
}

/* ============================ 配置文件读写 ============================ */

/** 判断配置文本是否包含指定 remote 的 section */
function hasSection(text: string, remote: string): boolean {
  const header = `[${remote}]`;
  return text.split(/\r?\n/).some((l) => l.trim() === header);
}

/** 提取指定 remote section 中某个键的值(用于保留 device_id 等非敏感字段) */
function extractSectionValue(text: string, remote: string, key: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const header = `[${remote}]`;
  let inSection = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      inSection = t === header;
      continue;
    }
    if (!inSection) continue;
    const m = t.match(new RegExp(`^${key}\\s*=\\s*(.*)$`));
    if (m) return m[1].trim();
  }
  return '';
}

/** 从配置文本中移除指定 remote 的整个 section(含全部键值),用于重新提交凭据前彻底清除旧配置 */
function removeSection(text: string, remote: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.length > 0 ? normalized.split('\n') : [];
  const header = `[${remote}]`;
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      skipping = t === header;
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  const result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return result ? result + '\n' : '';
}

/**
 * 交给 rclone config create 写入前,确保配置文件对当前进程可读写。
 * 权限/属主异常(如被其他进程以 root 属主回写)时:
 * - 先尝试 chmod 修复(属主正确、仅模式不对的场景)
 * - 仍不可用时删除并重建空文件(随后 config create 会重建完整配置)
 */
function ensureConfigFileWritable(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  try {
    fs.accessSync(configPath, fs.constants.R_OK | fs.constants.W_OK);
    return;
  } catch {
    /* 不可读写 → 尝试修复 */
  }
  try {
    fs.chmodSync(configPath, 0o600);
    fs.accessSync(configPath, fs.constants.R_OK | fs.constants.W_OK);
    return;
  } catch {
    /* chmod 不足以修复(属主问题) → 删除重建 */
  }
  try {
    fs.unlinkSync(configPath);
    fs.writeFileSync(configPath, '', { mode: 0o600 });
  } catch {
    throw new Error(
      'rclone 配置文件权限异常且无法自动修复,请重启容器(capturehub)后重试',
    );
  }
}

/* ============================ rclone 子进程 ============================ */

/** 用 `rclone obscure -`(stdin) 将明文密码转为配置可存储的混淆值 */
function obscurePassword(rcloneBin: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(rcloneBin, ['obscure', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject(new Error('rclone obscure 执行超时'));
      });
    }, 10_000);

    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      finish(() => reject(new Error('无法执行容器内 rclone,请检查镜像是否完整')));
    });
    child.on('close', (code) => {
      finish(() => {
        const val = out.trim();
        if (code !== 0 || !val || /[\r\n\u0000]/.test(val) || val.length > 4096) {
          reject(new Error('rclone 密码混淆失败'));
        } else {
          resolve(val);
        }
      });
    });

    try {
      child.stdin?.write(password + '\n');
      child.stdin?.end();
    } catch {
      /* close/error 事件会处理失败 */
    }
  });
}

/** 执行 `rclone lsd <remote>:` 测试远端连通性 */
function runLsd(
  rcloneBin: string,
  configPath: string,
  remote: string,
): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    let err = '';
    let settled = false;
    const finish = (r: { ok: boolean; error: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(
      rcloneBin,
      [
        'lsd',
        `${remote}:`,
        '--config',
        configPath,
        '--timeout',
        '15s',
        '--contimeout',
        '15s',
        '--retries',
        '1',
        '--low-level-retries',
        '1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: '连接测试超时' });
    }, 25_000);

    child.stdout?.on('data', () => {
      /* 丢弃目录列表输出 */
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
      // 防止超长错误输出撑爆内存
      if (err.length > 8192) err = err.slice(-8192);
    });
    child.on('error', () => {
      finish({ ok: false, error: '无法执行容器内 rclone,请检查镜像是否完整' });
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, error: null });
      } else {
        const lines = err
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        let msg = (lines[lines.length - 1] || `rclone 退出码 ${code}`).slice(0, 300);
        msg = sanitizeRcloneText(msg);
        if (/captcha_invalid/i.test(msg)) {
          msg = `网盘触发人机验证(风控限制),连接暂时不可用,系统将自动重试。${msg}`;
        }
        finish({ ok: false, error: msg });
      }
    });
  });
}

/** 获取容器内 rclone 版本(如 "rclone v1.75.1") */
function fetchVersion(rcloneBin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(rcloneBin, ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(null);
    }, 10_000);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.length > 2048) out = out.slice(0, 2048);
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
      finish(first || null);
    });
  });
}

/* ============================ 公开操作 ============================ */

/**
 * 执行 rclone config 子命令(参数数组,非交互)。
 * stdin 关闭:token 缺失时 backend 配置流程会自动用账号密码完成登录,
 * 不会等待交互输入;传入的密码为已 obscure 值,明文不经命令行。
 */
function runConfigCommand(
  args: string[],
  rcloneBin: string = getRcloneBin(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(rcloneBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject(new Error('网盘登录超时,请检查网络后重试'));
      });
    }, 120_000);

    child.stdout?.on('data', () => {
      /* 丢弃正常输出 */
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 8192) err = err.slice(-8192);
    });
    child.on('error', () => {
      finish(() => reject(new Error('无法执行容器内 rclone,请检查镜像是否完整')));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
          return;
        }
        const lines = err
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        let msg = (lines[lines.length - 1] || `rclone 退出码 ${code}`).slice(0, 300);
        msg = sanitizeRcloneText(msg);
        reject(new Error(`网盘登录失败: ${msg}`));
      });
    });
  });
}

/**
 * 生成/更新指定网盘的 remote 配置。
 * 密码经 rclone obscure 混淆后写入;文件权限强制 600。
 */
export async function writeRemoteConfig(
  opts: { provider: string; account: string; password: string },
  configPath: string = getRcloneConfigPath(),
): Promise<{ remote: string; provider: string }> {
  const { provider, account, password } = opts;
  if (!isValidProvider(provider)) throw new Error('不支持的网盘类型');
  const remote = provider;
  if (!isValidRemoteName(remote)) throw new Error('remote 名称非法');

  const acc = (account || '').trim();
  if (!acc || acc.length > 256 || /[\r\n\u0000]/.test(acc)) {
    throw new Error('网盘账号无效');
  }
  if (!password || password.length > 512 || /[\r\n\u0000]/.test(password)) {
    throw new Error('网盘密码无效');
  }

  const obscured = await obscurePassword(getRcloneBin(), password);

  // 读取旧配置:保留 device_id 设备指纹,并彻底移除旧 remote 段
  // (重新提交凭据时先删除旧配置,确保旧账号/token 不残留,再由下方流程用新凭据重建)
  let prevDeviceId = '';
  try {
    const existing = fs.readFileSync(configPath, 'utf8');
    prevDeviceId = extractSectionValue(existing, remote, 'device_id');
    const stripped = removeSection(existing, remote);
    if (stripped !== existing) {
      fs.writeFileSync(configPath, stripped, { mode: 0o600 });
    }
  } catch {
    /* 新配置;读取失败(权限)可由下方 ensureConfigFileWritable 兜底 */
  }

  // 确保配置文件可读写(权限异常时自愈),避免 rclone 无法加载配置
  ensureConfigFileWritable(configPath);

  // 使用 rclone 官方配置流程创建 remote:
  // 自动完成 账号密码登录 → token/captcha_token 获取 → 写回配置文件(非交互);
  // 传入的密码为已 obscure 混淆值,明文不经命令行/日志
  ensureDir(path.dirname(configPath));
  const args = ['config', 'create', remote, provider, `user=${acc}`, `pass=${obscured}`];
  if (/^[A-Za-z0-9_-]{1,128}$/.test(prevDeviceId)) {
    args.push(`device_id=${prevDeviceId}`);
  }
  args.push('--non-interactive', '--config', configPath);
  await runConfigCommand(args);

  // 以配置中确实写入了 token 为准(登录成功的标志)
  let ok = false;
  try {
    ok = !!extractSectionValue(fs.readFileSync(configPath, 'utf8'), remote, 'token');
  } catch {
    /* fallthrough */
  }
  if (!ok) throw new Error('网盘登录未完成,请重试或检查账号密码');

  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod,忽略 */
  }

  // 该账号值加入脱敏名单,后续日志/错误一律替换
  registerCredentialValue(acc);
  return { remote, provider };
}

/* ============================ 连接状态 ============================ */

interface RcloneCheckState {
  checking: boolean;
  configured: boolean;
  connected: boolean;
  lastError: string | null;
  checkedAt: number | null;
  version: string | null;
}

const state: RcloneCheckState = {
  checking: false,
  configured: false,
  connected: false,
  lastError: null,
  checkedAt: null,
  version: null,
};

// 探测频率刻意压低:PikPak 对高频 API 请求会触发人机验证(风控);
// 状态探测仅作低频体检,实际使用(上传成功)也会即时刷新连接状态
const OK_TTL_MS = 600_000; // 10 分钟
const FAIL_TTL_MS = 120_000; // 2 分钟(失败较快重试,风控解除后尽快恢复)
const CAPTCHA_RETRY_TTL_MS = 45_000; // 人机验证类失败:45 秒后快速重试
let inflight: Promise<void> | null = null;

export interface RcloneStatusView {
  provider: string;
  providerLabel: string;
  remoteName: string;
  rootPath: string;
  configured: boolean;
  connected: boolean;
  checking: boolean;
  lastError: string | null;
  checkedAt: string | null;
  rcloneVersion: string | null;
  providers: RcloneProviderInfo[];
}

async function runCheck(provider: string): Promise<void> {
  state.checking = true;
  try {
    const rcloneBin = getRcloneBin();
    if (!state.version) {
      state.version = await fetchVersion(rcloneBin);
    }
    loadCredentialValuesFromConfig();

    const conf = getRcloneConfigPath();
    let text = '';
    let readBlocked = false;
    try {
      text = fs.readFileSync(conf, 'utf8');
    } catch {
      readBlocked = fs.existsSync(conf);
    }
    if (readBlocked) {
      // 文件存在但当前用户不可读(典型:被其他进程以 root 属主回写)→ 明确提示修复方式
      state.configured = false;
      state.connected = false;
      state.lastError =
        'rclone 配置文件权限异常(当前用户不可读):在 rclone 卡片重新填写账号密码保存即可自动修复,或重启容器';
      state.checkedAt = Date.now();
      return;
    }
    state.configured = hasSection(text, provider);
    state.connected = false;
    state.lastError = null;

    if (state.configured) {
      const r = await runLsd(rcloneBin, conf, provider);
      state.connected = r.ok;
      state.lastError = r.ok ? null : r.error;
    }
    state.checkedAt = Date.now();
  } catch (e) {
    state.connected = false;
    state.lastError = sanitizeRcloneText(
      e instanceof Error ? e.message : String(e),
    ).slice(0, 300);
    state.checkedAt = Date.now();
  } finally {
    state.checking = false;
  }
}

function ensureCheck(provider: string) {
  if (inflight) return;
  inflight = runCheck(provider)
    .catch(() => {
      /* runCheck 内部已处理错误 */
    })
    .finally(() => {
      inflight = null;
    });
}

/** 生成配置后重置状态缓存,使下次查询立即触发重新检测 */
export function resetRcloneStatus() {
  state.checkedAt = null;
  state.lastError = null;
}

/** 上传等实际操作成功 → 直接记为已连接(不必等下次低频探测) */
export function markRcloneConnected() {
  const settings = loadSettings();
  if (!isValidProvider(settings.rcloneProvider)) return;
  state.configured = true;
  state.connected = true;
  state.lastError = null;
  state.checkedAt = Date.now();
}

/** 获取当前 rclone 连接状态视图(过期时自动触发后台检测) */
export function getRcloneStatusView(force = false): RcloneStatusView {
  const settings = loadSettings();
  const provider = isValidProvider(settings.rcloneProvider) ? settings.rcloneProvider : '';
  const base: RcloneStatusView = {
    provider,
    providerLabel: getProviderLabel(provider),
    remoteName: settings.rcloneRemote,
    rootPath: settings.rcloneRemotePath,
    configured: false,
    connected: false,
    checking: false,
    lastError: null,
    checkedAt: null,
    rcloneVersion: state.version,
    providers: listProviders(),
  };
  if (!provider) return base;

  const now = Date.now();
  const isCaptchaError = !!state.lastError && /captcha_invalid|人机验证/.test(state.lastError);
  const ttl = state.connected
    ? OK_TTL_MS
    : isCaptchaError
      ? CAPTCHA_RETRY_TTL_MS
      : FAIL_TTL_MS;
  const expired = state.checkedAt === null || now - state.checkedAt > ttl;
  if (force || expired) {
    void ensureCheck(provider);
  }
  return {
    ...base,
    configured: state.configured,
    connected: state.connected,
    checking: state.checking,
    lastError: state.lastError,
    checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
  };
}

/** 主动触发一次检测(用于保存配置后立即验证) */
export function triggerRcloneCheck() {
  const settings = loadSettings();
  if (isValidProvider(settings.rcloneProvider)) {
    void ensureCheck(settings.rcloneProvider);
  }
}
