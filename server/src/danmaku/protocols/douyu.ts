/**
 * 斗鱼弹幕协议 — STT 文本 + 原始 TCP
 * 移植自 biliup crates/danmaku/src/protocols/douyu.rs
 *
 * 流程:
 * - 连接 danmuproxy.douyu.com:8601 (备用 8602)
 * - 依次发送 loginreq / joingroup 注册包
 * - 每 45 秒发送心跳包 (type@=mrkl/)
 * - 数据帧: 4 字节长度(LE) + 4 字节长度(LE) + 4 字节类型(LE) + STT 文本 + \0
 * - 弹幕消息为 type@=chatmsg, 昵称 nn, 内容 txt, 颜色 col, 用户 uid
 */
import { decode as sttDecode, getStr } from '../codecs/stt.js';
import { DEFAULT_COLOR, newChatMessage, type ChatMessage } from '../types.js';

export const DOUYU_TCP_ENDPOINTS = ['danmuproxy.douyu.com:8601', 'danmuproxy.douyu.com:8602'];
export const DOUYU_HEARTBEAT_INTERVAL_MS = 45_000;

const MSG_TYPE = 689;

/** 心跳包: type@=mrkl/ */
export const DOUYU_HEARTBEAT: Buffer = Buffer.from([
  0x14, 0x00, 0x00, 0x00, // length = 20
  0x14, 0x00, 0x00, 0x00, // length = 20
  0xb1, 0x02, 0x00, 0x00, // type = 689
  0x74, 0x79, 0x70, 0x65, 0x40, 0x3d, 0x6d, 0x72, 0x6b, 0x6c, 0x2f, 0x00, // type@=mrkl/\0
]);

/** 斗鱼弹幕颜色码 → RGB 整数 */
export function colorFromCode(code: string | undefined): number {
  switch (code) {
    case '0':
      return 16777215; // 白
    case '1':
      return 16717077; // 红
    case '2':
      return 2000880; // 绿
    case '3':
      return 8046667; // 蓝
    case '4':
      return 16744192; // 橙
    case '5':
      return 10172916; // 紫
    case '6':
      return 16738740; // 粉
    default:
      return DEFAULT_COLOR;
  }
}

/** 从 URL 提取房间号 (douyu.com/123456) */
export function extractRoomId(url: string): string | null {
  const m = url.match(/douyu\.com\/(\d+)/);
  return m ? m[1] : null;
}

/** 构造一个 STT 数据包 (固定头 + 正文 + \0) */
export function buildPacket(data: string): Buffer {
  const body = Buffer.from(data, 'utf8');
  const length = 9 + body.length;
  const packet = Buffer.alloc(12 + body.length + 1);
  packet.writeUInt32LE(length, 0);
  packet.writeUInt32LE(length, 4);
  packet.writeUInt32LE(MSG_TYPE, 8);
  body.copy(packet, 12);
  packet[12 + body.length] = 0x00;
  return packet;
}

/** 构造登录 + 加入房间注册包 */
export function buildRegistrationPackets(roomId: string): Buffer[] {
  return [
    buildPacket(`type@=loginreq/roomid@=${roomId}/`),
    buildPacket(`type@=joingroup/rid@=${roomId}/gid@=-9999/`),
  ];
}

/** 解析单条 STT 消息为弹幕 (仅 chatmsg; 礼物/进场不计入弹幕) */
function parseSttMessage(text: string): ChatMessage | null {
  const msg = sttDecode(text);
  const msgType = getStr(msg, 'type');
  if (msgType !== 'chatmsg') return null;

  const name = getStr(msg, 'nn') ?? '';
  const content = getStr(msg, 'txt') ?? '';
  const color = colorFromCode(getStr(msg, 'col'));
  if (!content) return null;

  let uid = 0;
  const uidStr = getStr(msg, 'uid');
  if (uidStr) {
    const parsed = Number(uidStr);
    if (Number.isFinite(parsed)) uid = parsed;
  }
  return newChatMessage(content, { name, uid, color });
}

/**
 * 解析一段原始数据 (可能包含多个连续消息帧), 返回其中的弹幕
 */
export function parseMessages(data: Buffer): ChatMessage[] {
  const events: ChatMessage[] = [];
  let start = 0;
  while (start < data.length) {
    if (start + 12 > data.length) break;
    const length = data.readUInt32LE(start);
    if (start + 4 + length > data.length) break;

    const bodyStart = start + 12;
    const bodyEnd = start + 4 + length - 1; // 去掉末尾 \0
    if (bodyEnd > bodyStart && bodyEnd <= data.length) {
      const text = data.subarray(bodyStart, bodyEnd).toString('utf8');
      const chat = parseSttMessage(text);
      if (chat) events.push(chat);
    }
    start += 4 + length;
  }
  return events;
}

/** 拆分 TCP 端点 "host:port" */
export function parseEndpoint(endpoint: string): { host: string; port: number } {
  const idx = endpoint.lastIndexOf(':');
  const host = idx >= 0 ? endpoint.slice(0, idx) : endpoint;
  const port = idx >= 0 ? Number(endpoint.slice(idx + 1)) : 8601;
  return { host, port: Number.isFinite(port) ? port : 8601 };
}
