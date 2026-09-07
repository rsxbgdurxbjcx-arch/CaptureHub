/**
 * Stripchat 直播 API 层
 * 移植自 StripchatRecorder 的 backend/src/streaming/stripchat.rs
 * https://github.com/ChanTrail/StripchatRecorder
 *
 * 关键接口 (2026-08 起与 StripchatRecorder 完全一致):
 * 1. 直播状态(新流程): GET https://stripchat.com/api/front/v1/broadcasts/{username}
 *    取 item.streamName 作为模型索引,再请求
 *    GET https://stripchat.com/api/front/v2/models/{streamName}/cam
 *    注意: 旧端点 /api/front/v2/models/username/{username}/cam 已被 Stripchat
 *    停用(脚本请求返回 418),新流程已通过上游项目验证可用。
 * 2. 群组秀类型: GET https://stripchat.com/api/front/models?...&filterGroupTags=[["groupShow"]]
 * 3. master 播放列表: GET https://edge-hls.{tld}/hls/{model_id}/master/{model_id}_auto.m3u8
 *    多 CDN 顶级域名竞速: doppiocdn.com / .org / .live / .net
 * 4. Mouflon 加密: master 中 #EXT-X-MOUFLON:PSCH:scheme:key → 变体 URL 追加 psch/pkey
 *    variant 中 #EXT-X-MOUFLON:URI: 加密分片 → 使用 pdkey 做 SHA-256 XOR 解密
 *
 * 反拦截(418)加固:
 * - 所有 stripchat.com API 请求携带完整浏览器头(sec-ch-ua / sec-fetch-* / Origin 等),
 *   降低被 Cloudflare 式 WAF 判定为脚本的概率
 * - 对 403/418/429/5xx 等瞬时状态码自动指数退避重试(最多 3 次)
 */
import { fetch as undiciFetch } from 'undici';
import { createHash } from 'node:crypto';
import {
  StripchatQualityMappingBit,
  type StripchatCamResponse,
  type StripchatMouflonPair,
  type StripchatVariant,
} from './types.js';
import { sleep } from '../utils.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
/** 与 UA 对应的 sec-ch-ua (Chromium 136) */
const SEC_CH_UA = '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="39"';
const REFERER = 'https://stripchat.com/';

/** 支持的 CDN 顶级域名列表 (用于多 CDN 竞速) */
const CDN_TLDS = ['doppiocdn.com', 'doppiocdn.org', 'doppiocdn.live', 'doppiocdn.net'];

/** 新流程 Step 1: 按 username 获取广播信息,取 item.streamName 作为模型索引 */
const BROADCASTS_API = 'https://stripchat.com/api/front/v1/broadcasts/{username}';
/** 新流程 Step 2: 按 streamName 请求 cam 详情 (旧 username 路径端点已停用/418) */
const CAM_API = 'https://stripchat.com/api/front/v2/models/{modelId}/cam';
/** 旧版 cam 端点(按 username 路径),新流程异常时作为兜底 */
const LEGACY_CAM_API = 'https://stripchat.com/api/front/v2/models/username/{username}/cam';
const MODELS_API =
  'https://stripchat.com/api/front/models?removeShows=false&recInFeatured=false&limit={limit}&offset={offset}&primaryTag=girls&filterGroupTags=[[%22groupShow%22]]';

/** 需要退避重试的瞬时状态码 (418 = WAF/风控拦截, 429 = 限流, 5xx = 服务端抖动) */
const RETRYABLE_STATUS = new Set([403, 418, 429, 500, 502, 503, 504]);

interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
  /** 请求尝试次数(含首次),默认 3 */
  maxAttempts?: number;
}

/** 主播主页地址 (作为 Referer) */
function profileReferer(username: string): string {
  return `${REFERER}${encodeURIComponent(username)}`;
}

/**
 * 构造模拟浏览器 API 请求头。
 * Stripchat 的 WAF 会校验 sec-ch-ua / sec-fetch-* / Origin 等头,
 * 仅带 UA+Referer 的脚本请求容易触发 418。
 * page=true 时构造页面导航请求头(用于模型主页 HTML 兜底)。
 */
function buildBrowserHeaders(
  opts: { referer?: string; cookie?: string; page?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: opts.page
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': opts.page ? 'document' : 'empty',
    'Sec-Fetch-Mode': opts.page ? 'navigate' : 'cors',
    'Sec-Fetch-Site': 'same-origin',
    Referer: opts.referer ?? REFERER,
  };
  if (!opts.page) {
    // API 请求补充 XHR 头与 Origin (真实浏览器的同源 XHR 均携带)
    headers['X-Requested-With'] = 'XMLHttpRequest';
    headers.Origin = 'https://stripchat.com';
  }
  if (opts.cookie) headers.Cookie = opts.cookie;
  return headers;
}

/** 构造 CDN (edge-hls.doppiocdn.*) 请求头: 跨站请求只带 UA/Accept/Referer */
function buildCdnHeaders(opts: { cookie?: string } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    Referer: REFERER,
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  return headers;
}

/** 从新流程 broadcasts 响应中提取 item.streamName */
function extractStreamName(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const item = (json as Record<string, unknown>).item;
  if (!item || typeof item !== 'object') return null;
  const sn = (item as Record<string, unknown>).streamName;
  return typeof sn === 'string' && sn.trim() ? sn.trim() : null;
}

/** 读取响应体摘要(截断 + 压缩空白),用于构造错误信息;失败返回空串 */
async function safeBodyText(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch {
    return '';
  }
}

/**
 * GET 请求(带退避重试)。
 * 对网络错误与瞬时状态码(403/418/429/5xx)在退避后重试;
 * 最后一次尝试的响应原样返回,由调用方决定如何处理。
 */
async function doGet(url: string, options: FetchOptions = {}): Promise<Response> {
  const timeout = options.timeout ?? 20000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);

  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await undiciFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, ...options.headers },
        signal: controller.signal,
        redirect: 'follow' as const,
      } as any) as Response;

      if (!RETRYABLE_STATUS.has(resp.status) || attempt >= maxAttempts) {
        return resp;
      }
      // 瞬时错误 → 退避后重试
    } catch (e) {
      if (attempt >= maxAttempts) {
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(Math.min(3000, 800 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400));
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
 * 获取主播直播状态 (新流程)
 *
 * 按优先级依次尝试三条路径:
 * 1. 新流程(上游 2026-08-24 更新后的一致方案):
 *    Step 1: GET https://stripchat.com/api/front/v1/broadcasts/{username}
 *            → item.streamName (模型索引)
 *    Step 2: GET https://stripchat.com/api/front/v2/models/{streamName}/cam
 *            → 返回原始 JSON, 关键字段:
 *              - json.user.user.isLive / viewersCount / status / id / previewUrl / snapshotTimestamp
 *              - json.cam.streamName
 * 2. 兜底: 旧端点 /api/front/v2/models/username/{username}/cam (已停用, 脚本请求返回 418)
 * 3. 兜底: 模型主页 HTML 中的 window.__PRELOADED_STATE__ (yt-dlp 同款, 绕开 API)
 */
export async function fetchCamInfo(
  username: string,
  cookie?: string,
): Promise<StripchatCamResponse> {
  const errors: string[] = [];

  // ---- 方式1: 新流程 broadcasts → cam ----
  try {
    const bResp = await doGet(
      BROADCASTS_API.replace('{username}', encodeURIComponent(username)),
      { headers: buildBrowserHeaders({ referer: profileReferer(username), cookie }) },
    );
    if (bResp.status === 404) {
      throw new Error(`Stripchat 用户 ${username} 不存在`);
    }
    if (!bResp.ok) {
      const detail = await safeBodyText(bResp);
      errors.push(`broadcasts HTTP ${bResp.status}${detail ? ` [${detail}]` : ''}`);
    } else {
      const streamName = extractStreamName(await bResp.json());
      if (streamName) {
        return await fetchCamByModelId(streamName, username, cookie);
      }
      errors.push('broadcasts 响应缺少 item.streamName');
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Stripchat 用户')) throw e;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // ---- 方式2: 旧版 /models/username/{username}/cam ----
  try {
    const resp = await doGet(
      LEGACY_CAM_API.replace('{username}', encodeURIComponent(username)),
      { headers: buildBrowserHeaders({ referer: profileReferer(username), cookie }) },
    );
    if (resp.status === 404) {
      throw new Error(`Stripchat 用户 ${username} 不存在`);
    }
    if (resp.ok) {
      return (await resp.json()) as StripchatCamResponse;
    }
    const detail = await safeBodyText(resp);
    errors.push(`legacy cam HTTP ${resp.status}${detail ? ` [${detail}]` : ''}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Stripchat 用户')) throw e;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // ---- 方式3: 模型主页 HTML __PRELOADED_STATE__ (yt-dlp 同款, 绕开 API) ----
  try {
    const fromPage = await fetchCamInfoFromPage(username, cookie);
    if (fromPage) return fromPage;
    errors.push('页面 HTML 兜底失败(未找到 __PRELOADED_STATE__ 或字段缺失)');
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  throw new Error(
    `Stripchat API 返回错误 (${username}): ${errors.join('; ')}。` +
    `如持续出现 418/403,请稍后重试或配置 Stripchat Cookie 后重试。`,
  );
}

/** 新流程 Step 2: 按 streamName 请求 cam 接口;失败时抛出带状态码与响应摘要的错误 */
async function fetchCamByModelId(
  streamName: string,
  username: string,
  cookie?: string,
): Promise<StripchatCamResponse> {
  const resp = await doGet(
    CAM_API.replace('{modelId}', encodeURIComponent(streamName)),
    { headers: buildBrowserHeaders({ referer: profileReferer(username), cookie }) },
  );
  if (resp.status === 404) {
    throw new Error(`Stripchat 用户 ${username} 不存在`);
  }
  if (!resp.ok) {
    const detail = await safeBodyText(resp);
    throw new Error(`cam HTTP ${resp.status} (按 streamName=${streamName})${detail ? ` [${detail}]` : ''}`);
  }
  return (await resp.json()) as StripchatCamResponse;
}

/**
 * 兜底方案: 请求模型主页 HTML, 解析 window.__PRELOADED_STATE__
 * (yt-dlp StripchatIE 同款: 单次浏览器等价请求, 不走 API, 最不易被 418)。
 * 成功时构造为 StripchatCamResponse 形状, 使下游 getInfo/getStream 无需改动。
 * 解析失败或字段缺失时返回 null (由调用方继续其他兜底)。
 */
async function fetchCamInfoFromPage(
  username: string,
  cookie?: string,
): Promise<StripchatCamResponse | null> {
  // 依次尝试主页 URL 与直播间 URL 两种形式
  const candidates = [
    `https://stripchat.com/${encodeURIComponent(username)}`,
    `https://stripchat.com/${encodeURIComponent(username)}/myRoom`,
  ];

  for (const url of candidates) {
    const resp = await doGet(url, {
      headers: buildBrowserHeaders({ referer: url, cookie, page: true }),
    });
    if (!resp.ok) continue;
    const html = await resp.text();
    const state = parsePreloadedState(html);
    const cam = camResponseFromPreloadedState(state, username);
    if (cam) {
      console.log(`[stripchat] 通过模型主页 HTML 获取到 ${username} 的直播状态 (兜底路径)`);
      return cam;
    }
  }
  return null;
}

/** 从页面 HTML 中提取 window.__PRELOADED_STATE__ 的 JSON (花括号配对, 跳过字符串内容) */
function parsePreloadedState(html: string): unknown | null {
  const m = html.match(/window\.__PRELOADED_STATE__\s*=\s*\{/);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length - 1; // 指向第一个 '{'
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 将 __PRELOADED_STATE__ 映射为 cam API 响应形状 (best-effort, 如字段缺失返回 null) */
function camResponseFromPreloadedState(
  state: unknown,
  username: string,
): StripchatCamResponse | null {
  if (!state || typeof state !== 'object') return null;
  const root = state as Record<string, unknown>;
  const viewCam = root.viewCam as Record<string, unknown> | undefined;
  if (!viewCam || typeof viewCam !== 'object') return null;
  const model = viewCam.model as Record<string, unknown> | undefined;
  if (!model || typeof model !== 'object') return null;

  const idNum = Number(model.id);
  if (!Number.isFinite(idNum)) return null;

  const isLive = model.isLive === true;
  // viewCam.show 为对象时表示正在进行私密/群组秀 (yt-dlp 同款判定)
  const inShow = viewCam.show && typeof viewCam.show === 'object';
  const status =
    typeof model.status === 'string' && model.status
      ? model.status
      : inShow
        ? 'private'
        : isLive
          ? 'public'
          : 'off';

  const camObj = (viewCam.cam ?? {}) as Record<string, unknown>;
  const streamName =
    (typeof viewCam.streamName === 'string' && viewCam.streamName) ||
    (typeof model.streamName === 'string' && model.streamName) ||
    (typeof camObj.streamName === 'string' && camObj.streamName) ||
    undefined;

  const snapshotTs =
    typeof model.snapshotTimestamp === 'number' || typeof model.snapshotTimestamp === 'string'
      ? (model.snapshotTimestamp as number | string)
      : undefined;

  return {
    user: {
      user: {
        id: idNum,
        isLive,
        viewersCount:
          typeof model.viewersCount === 'number' ? model.viewersCount : undefined,
        status,
        snapshotTimestamp: snapshotTs,
        previewUrl:
          typeof model.previewUrl === 'string' ? model.previewUrl : undefined,
        username,
      },
    },
    cam: { streamName },
  };
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
    const headers = buildBrowserHeaders({ referer: REFERER, cookie });

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
 * 对所有 CDN TLD 并发竞速请求 master 播放列表, 返回最先成功的响应文本与基准 URL。
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
  const attempts = await Promise.all(
    candidates.map(async ({ tld, url }) => {
      try {
        const headers = buildCdnHeaders({ cookie });
        const resp = await doGet(url, { headers });
        if (resp.ok) {
          return { text: await resp.text(), baseUrl: url };
        }
        errors.push(`[${tld}] HTTP ${resp.status}`);
      } catch (e) {
        errors.push(`[${tld}] ${e instanceof Error ? e.message : e}`);
      }
      return null;
    }),
  );

  const firstOk = attempts.find((r) => r !== null);
  if (firstOk) return firstOk;

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
  const headers = buildCdnHeaders({ cookie });

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
