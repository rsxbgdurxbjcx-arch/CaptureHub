/**
 * 虎牙弹幕协议 — TARS 二进制 + WebSocket
 * 移植自 biliup crates/danmaku/src/protocols/huya.rs
 *
 * 流程:
 * - 连接 wss://cdnws.api.huya.com/ (需携带浏览器 UA)
 * - 从房间页提取主播 uid, 构造 WSUserInfo 注册包 (iCmdType=1) 注册
 * - 服务器以 WebSocketCommand (iCmdType=7) 推送消息;
 *   内层消息类型 1400 为弹幕 (昵称在 tag0 结构体 tag2, 内容在 tag3)
 * - 每 60 秒发送预编码的 TARS 心跳包
 */
import { fetch as undiciFetch } from 'undici';
import { TarsInputStream, TarsOutputStream } from '../../codec/tars.js';
import { DEFAULT_COLOR, newChatMessage, type ChatMessage } from '../types.js';

export const HUYA_WSS_URL = 'wss://cdnws.api.huya.com/';
export const HUYA_HEARTBEAT_INTERVAL_MS = 60_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** WebSocket 命令类型 */
const CMD_REGISTER_REQ = 1;
const CMD_MSG_PUSH_REQ = 7;

/** 预编码的 TARS 心跳包 (type@=OnUserHeartBeat 等价物) */
export const HUYA_HEARTBEAT: Buffer = Buffer.from([
  0x00, 0x03, 0x1d, 0x00, 0x00, 0x69, 0x00, 0x00, 0x00, 0x69, 0x10, 0x03, 0x2c, 0x3c, 0x4c, 0x56,
  0x08, 0x6f, 0x6e, 0x6c, 0x69, 0x6e, 0x65, 0x75, 0x69, 0x66, 0x0f, 0x4f, 0x6e, 0x55, 0x73, 0x65,
  0x72, 0x48, 0x65, 0x61, 0x72, 0x74, 0x42, 0x65, 0x61, 0x74, 0x7d, 0x00, 0x00, 0x3c, 0x08, 0x00,
  0x01, 0x06, 0x04, 0x74, 0x52, 0x65, 0x71, 0x1d, 0x00, 0x00, 0x2f, 0x0a, 0x0a, 0x0c, 0x16, 0x00,
  0x26, 0x00, 0x36, 0x07, 0x61, 0x64, 0x72, 0x5f, 0x77, 0x61, 0x70, 0x46, 0x00, 0x0b, 0x12, 0x03,
  0xae, 0xf0, 0x0f, 0x22, 0x03, 0xae, 0xf0, 0x0f, 0x3c, 0x42, 0x6d, 0x52, 0x02, 0x60, 0x5c, 0x60,
  0x01, 0x7c, 0x82, 0x00, 0x0b, 0xb0, 0x1f, 0x9c, 0xac, 0x0b, 0x8c, 0x98, 0x0c, 0xa8, 0x0c, 0x20,
]);

export interface HuyaConnectionInfo {
  url: string;
  headers: Record<string, string>;
  registration: Buffer;
}

/** 从 URL 提取房间号 (https://www.huya.com/123456 或 huya.com/别名) */
export function extractRoomId(url: string): string | null {
  const m = url.match(/huya\.com\/([^/?]+)/);
  return m ? m[1] : null;
}

/** 从房间页提取主播 UID */
async function fetchRoomUid(roomId: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await undiciFetch(`https://www.huya.com/${roomId}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    const page = await resp.text();
    const m = page.match(/uid['"]*:\s*['"]*(\d+)['"]*/);
    if (!m) {
      throw new Error('未能从虎牙房间页提取主播 UID');
    }
    const uid = Number(m[1]);
    if (!Number.isFinite(uid)) {
      throw new Error('虎牙主播 UID 不是有效数字');
    }
    return uid;
  } finally {
    clearTimeout(timer);
  }
}

/** 构造 WSUserInfo (注册包内层 TARS 结构) */
export function buildWsUserInfo(uid: number): Buffer {
  const oos = new TarsOutputStream();
  oos.writeInt64(0, uid); // lUid
  oos.writeBool(1, false); // bAnonymous
  oos.writeString(2, ''); // sGuid
  oos.writeString(3, ''); // sToken
  oos.writeInt64(4, 0); // lTid
  oos.writeInt64(5, 0); // lSid
  oos.writeInt64(6, uid); // lGroupId = uid
  oos.writeInt64(7, 3); // lGroupType = 3 (按主播 uid 订阅弹幕)
  return oos.getBuffer();
}

/** 构造 WebSocketCommand (外层 TARS 结构) */
export function buildWsCommand(cmdType: number, data: Buffer): Buffer {
  const oos = new TarsOutputStream();
  oos.writeInt32(0, cmdType);
  oos.writeBytes(1, data);
  return oos.getBuffer();
}

/** 构造连接信息 (含注册包; 每次重连都需要重新获取) */
export async function buildConnectionInfo(roomId: string): Promise<HuyaConnectionInfo> {
  const uid = await fetchRoomUid(roomId);
  const registration = buildWsCommand(CMD_REGISTER_REQ, buildWsUserInfo(uid));
  return {
    url: HUYA_WSS_URL,
    headers: { 'User-Agent': USER_AGENT },
    registration,
  };
}

/** 解析一条弹幕消息 (MessageNotice) */
export function parseHuyaDanmaku(data: Buffer): ChatMessage | null {
  const ios = new TarsInputStream(data);
  const name =
    ios.readStruct(0, (user) => user.readString(2) ?? '') ?? '';
  const content = ios.readString(3) ?? '';
  if (!content) return null;
  return newChatMessage(content, { name, color: DEFAULT_COLOR });
}

/** 解析 WebSocket 消息, 返回其中的弹幕 */
export function decodeHuyaMessages(data: Buffer): ChatMessage[] {
  const events: ChatMessage[] = [];
  const ios = new TarsInputStream(data);
  const cmdType = ios.readInt32(0) ?? 0;
  if (cmdType !== CMD_MSG_PUSH_REQ) return events;

  const innerData = ios.readBytes(1);
  if (!innerData) return events;

  const innerIos = new TarsInputStream(innerData);
  const msgType = innerIos.readInt64(1) ?? 0;
  if (msgType !== 1400) return events;

  const msgData = innerIos.readBytes(2);
  if (!msgData) return events;
  const chat = parseHuyaDanmaku(msgData);
  if (chat) events.push(chat);
  return events;
}
