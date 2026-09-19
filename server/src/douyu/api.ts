/**
 * 斗鱼直播 API 层
 * 移植自 biliup crates/biliup/src/downloader/live/douyu.rs
 *
 * 关键流程:
 * 1. resolveRealRoomId — 从 URL / 移动端页面解析真实房间号 (进程级缓存)
 * 2. fetchRoomInfo     — betard 接口检测直播状态 (show_status=1 且 videoLoop=0)
 * 3. getWebStreamUrl   — getEncryption 取签名密钥 (含服务器时间对齐与缓存,
 *                        鉴权失败自动刷新密钥重试一次) + getH5PlayV1 签名请求
 *                        → {rtmp_url}/{rtmp_live}
 *
 * 说明: 与 biliup 默认行为一致, 不使用 Cookie、不启用 huos P2P 中转
 * (force_hs=false)、rate 固定 0 (原画)。
 */
import { createHash } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import type {
  DouyuBetardResponse,
  DouyuBetardRoom,
  DouyuEncryptionResponse,
  DouyuEncryptKey,
  DouyuPlayInfo,
  DouyuPlayResponse,
} from './types.js';

const DOUYU_DEFAULT_DID = '10000000000000000000000000001501';
const DOUYU_WEB_DOMAIN = 'www.douyu.com';
const DOUYU_MOBILE_DOMAIN = 'm.douyu.com';
const DOUYU_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 请求使用的 CDN (与 biliup 默认值一致) */
export const DOUYU_DEFAULT_CDN = 'hw-h5';

interface HttpTextResult {
  status: number;
  text: string;
  date: string | null;
}

async function httpText(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<HttpTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15000);
  try {
    const resp = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await resp.text();
    return { status: resp.status, text, date: resp.headers.get('date') };
  } finally {
    clearTimeout(timer);
  }
}

function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** 解析 HTTP Date 响应头 (IMF-fixdate) 为 Unix 秒 */
function parseHttpDateSecs(value: string | null): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
}

/** 随机 Chrome UA (大版本 100~120, 对应 biliup random_user_agent) */
function randomChromeUserAgent(): string {
  const major = Math.floor(Math.random() * 21) + 100;
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/* ---------------- 房间号解析 ---------------- */

/** url → 真实房间号 缓存 (同一链接只解析一次移动端页面) */
const realRoomIdCache = new Map<string, string>();

/**
 * 解析真实房间号:
 * 1. URL 带 rid 查询参数且为纯数字时直接使用
 * 2. 否则请求 m.douyu.com/{shortId} 移动端页面, 提取 roomInfo.rid
 * 3. 页面未命中时, shortId 本身为纯数字则回退使用
 */
export async function resolveRealRoomId(inputUrl: string): Promise<string> {
  try {
    const parsed = new URL(inputUrl);
    const rid = parsed.searchParams.get('rid');
    if (rid && /^\d+$/.test(rid)) return rid;
  } catch {
    // 非标准 URL, 继续按路径解析
  }

  const shortId = inputUrl
    .split('douyu.com/')[1]
    ?.split('/')[0]
    ?.split('?')[0];
  if (!shortId) throw new Error('直播间地址错误');

  const cached = realRoomIdCache.get(inputUrl);
  if (cached) return cached;

  const { text } = await httpText(`https://${DOUYU_MOBILE_DOMAIN}/${shortId}`, {
    headers: { 'user-agent': DOUYU_USER_AGENT },
  });
  const m = text.match(/"roomInfo":\{"rid":(\d+)/);
  if (m) {
    realRoomIdCache.set(inputUrl, m[1]);
    return m[1];
  }
  if (/^\d+$/.test(shortId)) return shortId;
  throw new Error('获取斗鱼房间号错误');
}

/* ---------------- 房间信息 ---------------- */

/**
 * 获取房间信息; 在播返回房间对象, 不在播/无数据返回 null。
 * 网络层错误重试 3 次 (缓解海外请求失败); JSON 解析错误不重试。
 */
export async function fetchRoomInfo(roomId: string): Promise<DouyuBetardRoom | null> {
  let body: string | null = null;
  let lastError: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await httpText(`https://${DOUYU_WEB_DOMAIN}/betard/${roomId}`, {
        headers: { referer: `https://${DOUYU_WEB_DOMAIN}` },
      });
      body = r.text;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (body === null) {
    throw new Error(
      `获取斗鱼直播间信息失败 room_id: ${roomId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  let resp: DouyuBetardResponse;
  try {
    resp = JSON.parse(body) as DouyuBetardResponse;
  } catch (e) {
    throw new Error(
      `解析斗鱼直播间信息失败 room_id: ${roomId}: ${e instanceof Error ? e.message : e}`,
    );
  }
  const room = resp.room ?? null;
  if (!room) return null;
  if (room.show_status !== 1 || room.videoLoop !== 0) return null;
  return room;
}

/* ---------------- 播放地址 (加密签名) ---------------- */

interface CachedEncryptKey {
  key: DouyuEncryptKey;
  userAgent: string;
  /** getEncryption 响应 Date 相对本机时钟的偏移 (server - local), 秒 */
  serverTimeOffsetSecs: number;
}

let encryptKeyCache: CachedEncryptKey | null = null;
let keyRefreshInFlight: Promise<CachedEncryptKey> | null = null;

/** 清空缓存的加密密钥, 强制下次重新请求 (鉴权失败时调用) */
export function invalidateEncryptKey(): void {
  encryptKeyCache = null;
}

/** 请求新的加密密钥 + 随机 UA (配套使用, 成对缓存) */
async function refreshEncryptKey(): Promise<CachedEncryptKey> {
  const userAgent = randomChromeUserAgent();
  const r = await httpText(
    `https://${DOUYU_WEB_DOMAIN}/wgapi/livenc/liveweb/websec/getEncryption?did=${DOUYU_DEFAULT_DID}`,
    { headers: { 'user-agent': userAgent } },
  );
  // 本机时间在响应到达后取样, 使 Date 偏移更贴近本次响应
  const localNow = unixNow();
  const serverNow = parseHttpDateSecs(r.date) ?? localNow;
  const serverTimeOffsetSecs = serverNow - localNow;

  let resp: DouyuEncryptionResponse;
  try {
    resp = JSON.parse(r.text) as DouyuEncryptionResponse;
  } catch (e) {
    throw new Error(`解析斗鱼加密密钥失败: ${e instanceof Error ? e.message : e}`);
  }
  if (resp.error !== 0) {
    throw new Error(`getEncryption error: code=${resp.error}, msg=${resp.msg ?? ''}`);
  }
  if (!resp.data) throw new Error('斗鱼加密密钥为空');
  const cache: CachedEncryptKey = { key: resp.data, userAgent, serverTimeOffsetSecs };
  encryptKeyCache = cache;
  return cache;
}

/**
 * 获取加密密钥 (未过期直接复用; 并发刷新为 single-flight)
 */
async function getEncryptKey(): Promise<CachedEncryptKey> {
  const localNow = unixNow();
  if (encryptKeyCache) {
    const serverNow = localNow + encryptKeyCache.serverTimeOffsetSecs;
    if ((encryptKeyCache.key.expire_at ?? 0) > serverNow) return encryptKeyCache;
  }
  if (keyRefreshInFlight) return keyRefreshInFlight;
  keyRefreshInFlight = refreshEncryptKey().finally(() => {
    keyRefreshInFlight = null;
  });
  return keyRefreshInFlight;
}

/** 生成 getH5PlayV1 的 auth 签名 (MD5 链) */
export function signDouyuStream(key: DouyuEncryptKey, roomId: string, ts: number): string {
  const salt = key.is_special === 1 ? '' : `${roomId}${ts}`;
  let secret = key.rand_str;
  for (let i = 0; i < key.enc_time; i++) {
    secret = md5Hex(`${secret}${key.key}`);
  }
  return md5Hex(`${secret}${key.key}${salt}`);
}

/** 判定是否鉴权失败: HTTP 403, 或响应体含「鉴权失败」 */
function isDouyuAuthFailed(status: number, body: string): boolean {
  if (status === 403) return true;
  const normalized = body
    .trim()
    .replace(/^"+/, '')
    .replace(/"+$/, '')
    .replace(/\s+/g, '');
  return normalized.includes('鉴权失败');
}

/** 容忍 data 为 "" / null / 非对象 (错误响应常见), 仅对象视为播放信息 */
function normalizePlayData(data: unknown): DouyuPlayInfo | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as DouyuPlayInfo;
}

/** 从 cdnsWithName 反向取最后一个可用 cdn 名 */
function pickLastCdn(entries?: Array<{ cdn?: string | null }>): string | null {
  if (!entries) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cdn = entries[i]?.cdn;
    if (cdn) return cdn;
  }
  return null;
}

type PlayOutcome = { kind: 'ok'; play: DouyuPlayInfo } | { kind: 'auth' };

async function requestWebPlayInfo(roomId: string, cdn: string): Promise<PlayOutcome> {
  const cache = await getEncryptKey();
  const now = unixNow() + cache.serverTimeOffsetSecs;
  const auth = signDouyuStream(cache.key, roomId, now);

  const form = new URLSearchParams({
    cdn,
    rate: '0',
    ver: 'Douyu_new',
    iar: '0',
    ive: '0',
    rid: roomId,
    hevc: '0',
    fa: '0',
    sov: '0',
    enc_data: cache.key.enc_data,
    tt: String(now),
    did: DOUYU_DEFAULT_DID,
    auth,
  });

  const r = await httpText(`https://${DOUYU_WEB_DOMAIN}/lapi/live/getH5PlayV1/${roomId}`, {
    method: 'POST',
    headers: {
      referer: `https://${DOUYU_WEB_DOMAIN}`,
      'user-agent': cache.userAgent,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (isDouyuAuthFailed(r.status, r.text)) return { kind: 'auth' };

  let rsp: DouyuPlayResponse;
  try {
    rsp = JSON.parse(r.text) as DouyuPlayResponse;
  } catch (e) {
    throw new Error(
      `解析斗鱼播放信息失败 room_id: ${roomId}: ${e instanceof Error ? e.message : e}`,
    );
  }

  const data = normalizePlayData(rsp.data);
  if (rsp.error === 0 && data) return { kind: 'ok', play: data };
  if (rsp.msg?.includes('鉴权失败')) return { kind: 'auth' };
  if (rsp.error === -5) throw new Error('[closeRoom] 主播未开播');
  if (rsp.error === -9) throw new Error('[room_bus_checksevertime] 用户本机时间戳不对');
  if (rsp.error === 126) {
    throw new Error(`版权原因，该地域不允许播放：${rsp.msg ?? ''}`);
  }
  throw new Error(`获取斗鱼播放信息错误: code=${rsp.error}, msg=${rsp.msg ?? ''}`);
}

/**
 * 获取播放信息 (含 scdn 规避与鉴权失败重试):
 * - 返回 cdn 以 scdn 开头时, 换用列表中的其它 cdn 重试 (最多 3 轮)
 * - 鉴权失败时刷新加密密钥重试一次
 */
export async function fetchPlayInfo(
  roomId: string,
  cdn: string = DOUYU_DEFAULT_CDN,
): Promise<DouyuPlayInfo> {
  let currentCdn = cdn;
  let lastError: unknown = null;
  let keyRefreshed = false;
  for (let i = 0; i < 3; i++) {
    try {
      const outcome = await requestWebPlayInfo(roomId, currentCdn);
      if (outcome.kind === 'ok') {
        const play = outcome.play;
        if (play.rtmp_cdn?.startsWith('scdn')) {
          const next = pickLastCdn(play.cdnsWithName);
          if (next) {
            currentCdn = next;
            continue;
          }
        }
        return play;
      }
      if (!keyRefreshed) {
        invalidateEncryptKey();
        keyRefreshed = true;
        continue;
      }
      lastError = new Error('斗鱼播放信息鉴权失败');
      break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('获取斗鱼播放信息失败');
}

/** 获取完整拉流地址 ({rtmp_url}/{rtmp_live}) */
export async function getWebStreamUrl(
  roomId: string,
  cdn: string = DOUYU_DEFAULT_CDN,
): Promise<string> {
  const play = await fetchPlayInfo(roomId, cdn);
  return `${play.rtmp_url}/${play.rtmp_live}`;
}
