/**
 * 弹幕文本净化 — 屏蔽所有表情/emoji
 *
 * 三平台(虎牙/斗鱼/B站)的弹幕表情均为以下形式, 统一在此剥离:
 * - emoji 字符(含肤色修饰符、ZWJ 组合、变体选择符、旗帜区域指示符、标签字符);
 * - "[xxx]" / "[xxx_yyy]" 文本表情占位符(如 [捂脸] [dog] [热词系列_好耶]),
 *   三平台客户端将其渲染为表情图片, 属于"表情"而非普通文本。
 *
 * 过滤后为空白的结果由调用方丢弃(不上屏、不写入 XML)。
 * B 站协议级表情弹幕(emoticon_unique)在协议解析层直接丢弃, 不经过本函数。
 */

/** emoji 及组合字符 */
const EMOJI_RE =
  /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}]/gu;

/** 文本表情占位符: [xxx](不含空白/嵌套方括号, 长度 1~16) */
const TEXT_EMOTICON_RE = /\[[^\[\]\s]{1,16}\]/g;

/** 剥离 emoji 与文本表情占位符, 返回净化后的文本(可能为空) */
export function sanitizeDanmakuText(text: string): string {
  return text.replace(EMOJI_RE, '').replace(TEXT_EMOTICON_RE, '').trim();
}
