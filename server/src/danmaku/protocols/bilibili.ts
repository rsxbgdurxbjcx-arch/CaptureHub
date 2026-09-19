/**
 * Bilibili 弹幕协议 — 二进制 WebSocket
 * 移植自 biliup crates/danmaku/src/protocols/bilibili.rs (含 wbi.rs)
 *
 * 流程:
 * - 匿名 cookie (buvid3/buvid4, 经 spi 接口获取) 全程携带, 缓解风控
 * - WBI 签名请求 getDanmuInfo → token + host_list (失败即抛错, 由会话重连重试)
 * - 连接 wss://{host}:{wss_port}/sub, 发送 JSON 认证包 (protover=3, type=2, key=token)
 * - 每 30 秒发送二进制心跳; 服务器推送 16 字节头封包:
 *   version=0 原始 JSON / version=2 zlib / version=3 brotli (可嵌套)
 * - DANMU_MSG (弹幕) → ChatMessage: info[1]=内容, info[2][0]=uid,
 *   info[2][1]=昵称, info[0][3]=颜色
 */
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { fetch as undiciFetch } from 'undici';
import { DEFAULT_COLOR, newChatMessage, type ChatMessage } from '../types.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_WS_URL = 'wss://broadcastlv.chat.bilibili.com/sub';

export const BILI_HEARTBEAT_INTERVAL_MS = 30_000;

/** 预编码的二进制心跳 (len=31, ver=1, op=2, body="[object Object] ") */
export const BILI_HEARTBEAT: Buffer = Buffer.from([
  0x00, 0x00, 0x00, 0x1f, 0x00, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
  0x5b, 0x6f, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x20, 0x4f, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x5d, 0x20,
]);

/** 单包上限 (防御畸形/敌意输入) */
const MAX_PACKET_BYTES = 16 * 1024 * 1024;
/** 压缩嵌套深度上限 (真实协议只嵌套一层) */
const MAX_DECODE_DEPTH = 8;

/* ---------------- WBI 签名 ---------------- */

/** WBI mixin key 索引表 (biliup wbi.rs 同款) */
const WBI_KEY_MAP: number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const WBI_KEY_TTL_MS = 2 * 60 * 60 * 1000;

let wbiKeyCache: { mixinKey: string; fetchedAt: number } | null = null;
let wbiKeyInFlight: Promise<string> | null = null;

function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/** 从 nav 接口取 img/sub key 并生成 mixin key */
async function refreshWbiMixinKey(cookie: string): Promise<string> {
  const resp = await fetchJson('https://api.bilibili.com/x/web-interface/nav', cookie);
  const imgUrl = String(resp?.data?.wbi_img?.img_url ?? '');
  const subUrl = String(resp?.data?.wbi_img?.sub_url ?? '');
  const imgKey = imgUrl.split('/').pop()?.split('.')[0] ?? '';
  const subKey = subUrl.split('/').pop()?.split('.')[0] ?? '';
  if (imgKey.length < 32 || subKey.length < 32) {
    throw new Error('获取 B 站 WBI 密钥失败');
  }
  const full = imgKey + subKey;
  const mixinKey = WBI_KEY_MAP.slice(0, 32)
    .map((i) => full[i] ?? '')
    .join('');
  wbiKeyCache = { mixinKey, fetchedAt: Date.now() };
  return mixinKey;
}

/** 获取 mixin key (2 小时缓存 + single-flight; 直播取流模块共用) */
export async function getWbiMixinKey(cookie: string): Promise<string> {
  if (wbiKeyCache && Date.now() - wbiKeyCache.fetchedAt < WBI_KEY_TTL_MS) {
    return wbiKeyCache.mixinKey;
  }
  if (wbiKeyInFlight) return wbiKeyInFlight;
  wbiKeyInFlight = refreshWbiMixinKey(cookie).finally(() => {
    wbiKeyInFlight = null;
  });
  return wbiKeyInFlight;
}

/** WBI 签名: 参数 + wts 过滤 !'()* 并按 key 排序, w_rid = md5(query + mixinKey) */
export function wbiSign(params: Record<string, string>, mixinKey: string): string {
  params.wts = String(Math.floor(Date.now() / 1000));
  const sorted = Object.keys(params).sort();
  const query = sorted
    .map((k) => {
      const v = String(params[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5Hex(query + mixinKey)}`;
}

/* ---------------- buvid cookie ---------------- */

const BUVid_TTL_MS = 12 * 60 * 60 * 1000;
let buvidCache: { cookie: string; fetchedAt: number } | null = null;

/** 生成伪造 buvid3 (对齐 biliup, 仅作 spi 失败时的兜底) */
function generateFakeBuvid3(): string {
  const hex = Math.random().toString(16).slice(2).padEnd(36, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}infoc`;
}

/** 获取匿名 buvid3/buvid4 cookie (12 小时缓存; 失败时兜底伪造 buvid3, 不缓存) */
async function getBuvidCookie(): Promise<string> {
  if (buvidCache && Date.now() - buvidCache.fetchedAt < BUVid_TTL_MS) {
    return buvidCache.cookie;
  }
  try {
    const resp = await fetchJson(
      'https://api.bilibili.com/x/frontend/finger/spi',
      '',
      USER_AGENT,
    );
    const b3 = String(resp?.data?.b_3 ?? '');
    const b4 = String(resp?.data?.b_4 ?? '');
    if (b3 && b4) {
      const cookie = `buvid3=${b3}; buvid4=${b4};`;
      buvidCache = { cookie, fetchedAt: Date.now() };
      return cookie;
    }
  } catch {
    // 落到伪造兜底
  }
  return `buvid3=${generateFakeBuvid3()};`;
}

/* ---------------- HTTP 工具 ---------------- */

async function fetchJson(
  url: string,
  cookie: string,
  userAgent: string = USER_AGENT,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await undiciFetch(url, {
      headers: {
        'User-Agent': userAgent,
        Referer: 'https://live.bilibili.com/',
        Origin: 'https://live.bilibili.com',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: controller.signal,
    });
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 连接信息 ---------------- */

export interface BiliConnectionInfo {
  url: string;
  headers: Record<string, string>;
  registration: Buffer;
}

/** 短号 → 真实房间号 (进程内缓存) */
const realRoomIdCache = new Map<string, number>();

async function resolveRealRoomId(roomId: string, cookie: string): Promise<number> {
  const cached = realRoomIdCache.get(roomId);
  if (cached) return cached;
  const resp = await fetchJson(
    `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
    cookie,
  );
  const real = Number(resp?.data?.room_id);
  if (!Number.isFinite(real) || real <= 0) {
    throw new Error(`B 站房间号解析失败: ${roomId}`);
  }
  realRoomIdCache.set(roomId, real);
  return real;
}

/** 构造认证包 (JSON body + 16 字节头, op=7) */
export function buildAuthPacket(roomId: number, token: string): Buffer {
  const body = Buffer.from(
    JSON.stringify({ uid: 0, roomid: roomId, protover: 3, platform: 'web', type: 2, key: token }),
    'utf8',
  );
  const buf = Buffer.alloc(16 + body.length);
  buf.writeUInt32BE(16 + body.length, 0);
  buf.writeUInt16BE(16, 4);
  buf.writeUInt16BE(1, 6);
  buf.writeUInt32BE(7, 8);
  buf.writeUInt32BE(1, 12);
  body.copy(buf, 16);
  return buf;
}

/**
 * 构造连接信息 (含认证包; 每次重连都需要重新获取 token)。
 * getDanmuInfo 失败时抛错 —— 空 token 认证会被服务器拒绝, 不降级。
 */
export async function buildConnectionInfo(roomId: string): Promise<BiliConnectionInfo> {
  const cookie = await getBuvidCookie();
  const realRoomId = await resolveRealRoomId(roomId, cookie);

  const mixinKey = await getWbiMixinKey(cookie);
  const query = wbiSign(
    { id: String(realRoomId), type: '0', web_location: '444.8' },
    mixinKey,
  );
  const resp = await fetchJson(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
    cookie,
  );
  if (resp?.code !== 0) {
    throw new Error(`getDanmuInfo 失败: code=${resp?.code}, msg=${resp?.message ?? ''}`);
  }
  const token = String(resp?.data?.token ?? '');
  if (!token) throw new Error('getDanmuInfo 未返回 token');
  const host = resp?.data?.host_list?.[0];
  const url = host?.host
    ? `wss://${host.host}:${host.wss_port ?? 443}/sub`
    : DEFAULT_WS_URL;

  return {
    url,
    headers: {
      'User-Agent': USER_AGENT,
      Origin: 'https://live.bilibili.com',
      Referer: 'https://live.bilibili.com/',
      Cookie: cookie,
    },
    registration: buildAuthPacket(realRoomId, token),
  };
}

/* ---------------- 消息解码 ---------------- */

interface JsonLike {
  [key: string]: unknown;
}

/** 解析 DANMU_MSG → ChatMessage (表情弹幕直接丢弃: 用户要求屏蔽所有表情) */
function parseDanmuMsg(json: JsonLike): ChatMessage | null {
  const cmd = String(json.cmd ?? '');
  if (cmd.split(':')[0] !== 'DANMU_MSG') return null;
  const info = json.info;
  if (!Array.isArray(info)) return null;
  const content = typeof info[1] === 'string' ? info[1] : '';
  if (!content) return null;

  // 表情弹幕: info[0][15].extra.emoticon_unique 存在即为表情 → 整条丢弃
  const meta = Array.isArray(info[0]) ? (info[0] as unknown[]) : [];
  const extraObj = meta[15];
  if (extraObj && typeof extraObj === 'object') {
    const extraStr = (extraObj as JsonLike).extra;
    if (typeof extraStr === 'string') {
      try {
        const extra = JSON.parse(extraStr) as JsonLike;
        if (typeof extra.emoticon_unique === 'string' && extra.emoticon_unique) {
          return null;
        }
      } catch {
        // 保留原文
      }
    }
  }

  const user = Array.isArray(info[2]) ? (info[2] as unknown[]) : [];
  const uid = typeof user[0] === 'number' ? user[0] : 0;
  const name = typeof user[1] === 'string' ? user[1] : '';
  const color = typeof meta[3] === 'number' ? (meta[3] as number) : DEFAULT_COLOR;
  return newChatMessage(content, { name, uid, color });
}

/** 递归解码封包 (支持 zlib/brotli 嵌套), 输出收到的弹幕 */
function decodePackets(data: Buffer, out: ChatMessage[], depth: number): void {
  if (depth > MAX_DECODE_DEPTH) return;
  let offset = 0;
  while (offset + 16 <= data.length) {
    const len = data.readUInt32BE(offset);
    const version = data.readUInt16BE(offset + 6);
    const operation = data.readUInt32BE(offset + 8);
    if (len < 16 || len > MAX_PACKET_BYTES || offset + len > data.length) break;
    const body = data.subarray(offset + 16, offset + len);

    if (version === 2) {
      try {
        decodePackets(zlib.inflateSync(body), out, depth + 1);
      } catch {
        // 解压失败: 丢弃该包
      }
    } else if (version === 3) {
      try {
        decodePackets(zlib.brotliDecompressSync(body), out, depth + 1);
      } catch {
        // 解压失败: 丢弃该包
      }
    } else if (version === 0 && operation === 5) {
      try {
        const json = JSON.parse(body.toString('utf8')) as JsonLike;
        const chat = parseDanmuMsg(json);
        if (chat) out.push(chat);
      } catch {
        // 非 JSON 或未知消息: 忽略
      }
    }
    offset += len;
  }
}

/** 解析 WebSocket 二进制消息, 返回其中的弹幕 */
export function decodeBiliMessages(data: Buffer): ChatMessage[] {
  const out: ChatMessage[] = [];
  decodePackets(data, out, 0);
  return out;
}
