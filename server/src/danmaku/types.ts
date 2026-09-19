/**
 * 弹幕消息类型
 * 移植自 biliup crates/danmaku/src/message.rs (仅保留弹幕录制实际使用的部分)
 */

/** 白色 (十六进制 0xFFFFFF) */
export const DEFAULT_COLOR = 16777215;

/** 一条聊天弹幕消息 */
export interface ChatMessage {
  /** 弹幕文本内容 */
  content: string;
  /** 发送者昵称 (可能为空) */
  name: string;
  /** 发送者用户 ID (未知为 0) */
  uid: number;
  /** 弹幕颜色 (RGB 整数, 默认白色) */
  color: number;
  /** 收到消息的时间 */
  timestamp: Date;
}

export function newChatMessage(
  content: string,
  opts: { name?: string; uid?: number; color?: number } = {},
): ChatMessage {
  return {
    content,
    name: opts.name ?? '',
    uid: opts.uid ?? 0,
    color: opts.color ?? DEFAULT_COLOR,
    timestamp: new Date(),
  };
}
