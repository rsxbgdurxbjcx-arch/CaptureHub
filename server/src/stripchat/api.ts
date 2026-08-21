/**
 * Stripchat 直播 API 层
 * 移植自 StripchatRecorder 的 backend/src/streaming/stripchat.rs
 * https://github.com/ChanTrail/StripchatRecorder
 *
 * 关键接口 (与 StripchatRecorder 完全一致):
 * - 直播状态: GET https://stripchat.com/api/front/v2/models/username/{username}/cam
 * - 群组秀类型: GET https://stripchat.com/api/front/models?...&filterGroupTags=[["groupShow"]]
 * - master 播放列表: GET https://edge-hls.{tld}/hls/{model_id}/master/{model_id}_auto.m3u8
 *   多 CDN 顶级域名竞速: doppiocdn.com / .org / .live / .net
 * - Mouflon 加密: master 中 #EXT-X-MOUFLON:PSCH:scheme:key → 变体 URL 追加 psch/pkey
 *   variant 中 #EXT-X-MOUFLON:URI: 加密分片 → 使用 pdkey 做 SHA-256 XOR 解密
 */
import { fetch as undiciFetch } from 'undici';
import { createHash } from 'node:crypto';
import {
  StripchatQualityMappingBit,
  type StripchatCamResponse,
  type StripchatMouflonPair,
  type StripchatVariant,
} from './types.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const REFERER = 'https://stripchat.com/';

/** 支持的 CDN 顶级域名列表 (用于多 CDN 竞速) */
const CDN_TLDS = ['doppiocdn.com', 'doppiocdn.org', 'doppiocdn.live', 'doppiocdn.net'];

const CAM_API = 'https://stripchat.com/api/front/v2/models/username/{username}/cam';
const MODELS_API =
  'https://stripchat.com/api/front/models?removeShows=false&recInFeatured=false&limit={limit}&offset={offset}&primaryTag=girls&filterGroupTags=[[%22groupShow%22]]';

interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

async function doGet(url: string, options: FetchOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = options.timeout ?? 20000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return (await undiciFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, ...options.headers },
      signal: controller.signal,
      redirect: 'follow' as const,
    } as any)) as Response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 Mouflon 密钥配置文本 (pkey=pdkey 每行一条, 支持 # 注释)
 * 返回 pkey -> pdkey 映射
 */
export function parseMouflonKeys(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!text) return result;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const pkey = line.slice(0, idx).trim();
    const pdkey = line.slice(idx + 1).trim();
    if (pkey && pdkey) result[pkey] = pdkey;
  }
  return result;
}

/** 提取 URL 前缀 (去掉最后一个路径段) */
export function getUrlPrefix(url: string): string {
  const idx = url.lastIndexOf('/');
  return idx >= 0 ? url.slice(0, idx) : url;
}

/** 将相对 URL 解析为绝对 URL */
export function resolveUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/**
 * 获取主播直播状态 (cam API)
 * GET https://stripchat.com/api/front/v2/models/username/{username}/cam
 *
 * 返回原始 JSON, 关键字段:
 * - json.user.user.isLive / viewersCount / status / id / previewUrl / snapshotTimestamp
 * - json.cam.streamName
 */
export async function fetchCamInfo(
  username: string,
  cookie?: string,
): Promise<StripchatCamResponse> {
  const url = CAM_API.replace('{username}', encodeURIComponent(username));
  const headers: Record<string, string> = {
    Referer: `${REFERER}${encodeURIComponent(username)}`,
  };
  if (cookie) headers.Cookie = cookie;

  const resp = await doGet(url, { headers });
  if (resp.status === 404) {
    throw new Error(`Stripchat 用户 ${username} 不存在`);
  }
  if (!resp.ok) {
    throw new Error(`Stripchat API 返回 ${resp.status} (${username})`);
  }
  return (await resp.json()) as StripchatCamResponse;
}

/**
 * 查询主播是否处于群组秀状态, 返回群组秀类型 (ticket / perMinute)
 * 仅当 status == "groupShow" 时调用
 */
export async function fetchGroupShowType(
  username: string,
  cookie?: string,
): Promise<string | null> {
  const LIMIT = 60;
  let offset = 0;
  while (true) {
    const url = MODELS_API
      .replace('{limit}', String(LIMIT))
      .replace('{offset}', String(offset));
    const headers: Record<string, string> = { Referer: REFERER };
    if (cookie) headers.Cookie = cookie;

    let json: any;
    try {
      const resp = await doGet(url, { headers });
      if (!resp.ok) return null;
      json = await resp.json();
    } catch {
      return null;
    }

    const models: Array<any> = json?.models ?? [];
    for (const m of models) {
      if (m?.username === username) {
        const t = m?.groupShowType;
        return typeof t === 'string' ? t : null;
      }
    }
    if (models.length < LIMIT) return null;
    offset += LIMIT;
  }
}

/**
 * 对所有 CDN TLD 竞速请求 master 播放列表, 返回最先成功的响应文本与基准 URL。
 * Race all CDN TLDs for `_auto.m3u8` master playlist.
 */
export async function fetchMasterPlaylist(
  modelId: number,
  cookie?: string,
): Promise<{ text: string; baseUrl: string }> {
  const candidates = CDN_TLDS.map((tld) => ({
    tld,
    url: `https://edge-hls.${tld}/hls/${modelId}/master/${modelId}_auto.m3u8`,
  }));

  const errors: string[] = [];
  for (const { tld, url } of candidates) {
    try {
      const headers: Record<string, string> = { Referer: REFERER };
      if (cookie) headers.Cookie = cookie;
      const resp = await doGet(url, { headers });
      if (resp.ok) {
        const text = await resp.text();
        return { text, baseUrl: url };
      }
      errors.push(`[${tld}] HTTP ${resp.status}`);
    } catch (e) {
      errors.push(`[${tld}] ${e instanceof Error ? e.message : e}`);
    }
  }

  throw new Error(`Stripchat 所有 CDN 域名请求 master 播放列表失败: ${errors.join('; ')}`);
}

/**
 * 解析 master m3u8 文本, 提取所有画质变体与 Mouflon PSCH 参数对。
 *
 * - 收集 #EXT-X-MOUFLON:PSCH:scheme:key (scheme=psch, key=pkey)
 * - 解析 #EXT-X-STREAM-INF:BANDWIDTH=... + 后续 URL 行 → variant
 * - 按 BANDWIDTH 从高到低排序
 */
export function parseMasterPlaylist(text: string): {
  variants: StripchatVariant[];
  mouflonPairs: StripchatMouflonPair[];
} {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((l) => l.trim());

  const mouflonPairs: StripchatMouflonPair[] = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MOUFLON:PSCH:')) {
      const rest = line.slice('#EXT-X-MOUFLON:PSCH:'.length);
      const idx = rest.indexOf(':');
      if (idx > 0) {
        mouflonPairs.push({ psch: rest.slice(0, idx), pkey: rest.slice(idx + 1) });
      }
    }
  }

  const variants: StripchatVariant[] = [];
  let pendingBandwidth: number | null = null;
  let pendingResolution: string | undefined;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
      pendingBandwidth = null;
      pendingResolution = undefined;
      for (const seg of attrs.split(',')) {
        const s = seg.trim();
        if (s.startsWith('BANDWIDTH=')) {
          const n = Number(s.slice('BANDWIDTH='.length));
          pendingBandwidth = Number.isFinite(n) ? n : null;
        } else if (s.startsWith('RESOLUTION=')) {
          pendingResolution = s.slice('RESOLUTION='.length);
        }
      }
    } else if (line && !line.startsWith('#')) {
      if (pendingBandwidth !== null) {
        variants.push({ url: line, bandwidth: pendingBandwidth, resolution: pendingResolution });
        pendingBandwidth = null;
        pendingResolution = undefined;
      }
    } else {
      pendingBandwidth = null;
      pendingResolution = undefined;
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { variants, mouflonPairs };
}

/**
 * 根据期望画质选择变体 (与 pandalive 的 selectQuality 一致)
 * - OD(原画): 选 BANDWIDTH 最高的
 * - 其他: 选不超过目标码率的最大值, 找不到则选最高
 */
export function selectQuality(
  variants: StripchatVariant[],
  desiredQuality: string,
): StripchatVariant | null {
  if (variants.length === 0) return null;
  if (desiredQuality === 'OD') return variants[0];

  const desiredBitrate = StripchatQualityMappingBit[desiredQuality] ?? 99999;
  const matched = variants.find((v) => v.bandwidth <= desiredBitrate * 1000);
  return matched || variants[0];
}

/**
 * 构建最终可播放的变体 URL:
 * 1. 将相对变体 URL 解析为绝对 URL
 * 2. 若存在 Mouflon 参数, 追加 psch/pkey (优先使用用户已配置 pkey 的 pair)
 */
export function buildStreamUrl(
  variantUrl: string,
  baseUrl: string,
  mouflonPairs: StripchatMouflonPair[],
  mouflonKeys?: Record<string, string>,
): string {
  const url = resolveUrl(variantUrl, baseUrl);
  if (mouflonPairs.length === 0) return url;

  const matched = mouflonPairs.find((p) => !!mouflonKeys?.[p.pkey]);
  const pair = matched || mouflonPairs[0];
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}psch=${encodeURIComponent(pair.psch)}&pkey=${encodeURIComponent(pair.pkey)}`;
}

/** 用于从加密 URL 中提取加密字符串和序号的正则 (与 StripchatRecorder 一致) */
const SEGMENT_REGEX = /_([^_]+)_(\d+(?:_part\d+)?)\.mp4(?:[?#].*)?/;

/**
 * 使用 SHA-256(pdkey) 对 Mouflon 加密的分片 URL 做 XOR 解密。
 * 流程: 提取加密字符串 → 反转并补齐 Base64 → 解码 → SHA-256(key) XOR → 替换回 URL
 */
export function decryptSegmentUrl(encodedUrl: string, key: string): string {
  const m = encodedUrl.match(SEGMENT_REGEX);
  if (!m) return encodedUrl;
  const encryptedStr = m[1];

  let reversed = encryptedStr.split('').reverse().join('');
  while (reversed.length % 4 !== 0) reversed += '=';

  let encryptedBytes: Buffer;
  try {
    encryptedBytes = Buffer.from(reversed, 'base64');
  } catch {
    return encodedUrl;
  }

  const keyBytes = createHash('sha256').update(key, 'utf8').digest();
  const decrypted = Buffer.from(
    encryptedBytes.map((b, i) => b ^ keyBytes[i % keyBytes.length]),
  );
  return encodedUrl.replace(encryptedStr, decrypted.toString('utf8'));
}

/**
 * 解析 variant m3u8 播放列表 (供解密/诊断使用, 与 StripchatRecorder 的 parse_playlist 一致)
 * 提取分片 URL (含 Mouflon 解密) 与 fMP4 初始化段 URL。
 */
export function parsePlaylist(
  playlist: string,
  urlPrefix: string,
  mouflonKeys: Record<string, string>,
): { segments: string[]; initUrl: string | null } {
  const segments: string[] = [];
  let initUrl: string | null = null;
  let currentPkey: string | null = null;

  const lines = playlist.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('#EXT-X-MOUFLON:PSCH')) {
      const parts = line.split(':');
      if (parts.length >= 4) {
        const pkey = parts[3];
        currentPkey = mouflonKeys[pkey] ?? null;
      }
    }

    if (line.includes('EXT-X-MAP:URI')) {
      const start = line.indexOf('"');
      const end = start >= 0 ? line.indexOf('"', start + 1) : -1;
      if (start >= 0 && end > start) {
        const headerPath = line.slice(start + 1, end);
        initUrl = /^https?:\/\//i.test(headerPath)
          ? headerPath
          : `${urlPrefix}/${headerPath}`;
      }
    }

    if (!line || line.startsWith('#')) continue;

    const prevLine = i > 0 ? lines[i - 1] : '';
    let url: string;
    if (prevLine.startsWith('#EXT-X-MOUFLON:URI:')) {
      let rawUrl = prevLine.slice('#EXT-X-MOUFLON:URI:'.length);
      if (rawUrl.startsWith('//')) rawUrl = `https:${rawUrl}`;
      else if (!/^https?:\/\//i.test(rawUrl)) rawUrl = `https://${rawUrl}`;
      url = currentPkey ? decryptSegmentUrl(rawUrl, currentPkey) : rawUrl;
    } else if (/^https?:\/\//i.test(line)) {
      url = line;
    } else {
      url = `${urlPrefix}/${line}`;
    }

    segments.push(url);
  }

  return { segments, initUrl };
}

/**
 * 多 CDN 顶级域名竞速下载 (与 StripchatRecorder cdn_get 一致)。
 * 对包含 doppiocdn 域名的 URL, 依次尝试 .com/.org/.live/.net 顶级域名, 返回最先成功的响应。
 * 若 URL 不含 CDN 域名, 直接请求。
 */
async function cdnGet(url: string, cookie?: string): Promise<Response> {
  const srcTld = CDN_TLDS.find((t) => url.includes(t));
  const headers: Record<string, string> = { Referer: REFERER };
  if (cookie) headers.Cookie = cookie;

  if (!srcTld) {
    return doGet(url, { headers });
  }

  const errors: string[] = [];
  for (const tld of CDN_TLDS) {
    const candidate = url.replace(srcTld, tld);
    try {
      const resp = await doGet(candidate, { headers });
      if (resp.ok) return resp;
      errors.push(`[${tld}] HTTP ${resp.status}`);
    } catch (e) {
      errors.push(`[${tld}] ${e instanceof Error ? e.message : e}`);
    }
  }
  throw new Error(`Stripchat CDN 下载失败: ${errors.join('; ')}`);
}

/**
 * 下载 HLS 播放列表文本 (变体 m3u8)。
 * Download the HLS playlist text content.
 */
export async function fetchPlaylist(playlistUrl: string, cookie?: string): Promise<string> {
  const resp = await cdnGet(playlistUrl, cookie);
  return await resp.text();
}

/**
 * 下载单个 HLS 分片的字节数据。
 * Download the byte data of a single HLS segment.
 */
export async function downloadSegment(url: string, cookie?: string): Promise<Buffer> {
  const resp = await cdnGet(url, cookie);
  const buf = await resp.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * 从 Mouflon Worker 同步密钥 (与 StripchatRecorder sync_mouflon_keys_from_worker 一致)。
 * GET {worker_url}, 可选 Authorization: Bearer {token}。
 * 返回 { keys: {pkey: pdkey}, updated_at: RFC3339 }。
 */
export async function syncMouflonKeysFromWorker(
  workerUrl: string,
  authToken?: string,
): Promise<{ keys: Record<string, string>; updatedAt: string } | null> {
  if (!workerUrl) return null;
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const resp = await doGet(workerUrl, { headers, timeout: 15000 });
  if (!resp.ok) {
    throw new Error(`Mouflon Worker 返回错误状态: ${resp.status}`);
  }
  const json = (await resp.json()) as {
    keys?: Record<string, string>;
    updated_at?: string;
  };
  return {
    keys: json.keys ?? {},
    updatedAt: json.updated_at ?? '',
  };
}
