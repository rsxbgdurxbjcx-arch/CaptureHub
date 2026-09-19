/**
 * STT (Serialized Text Transfer) 编解码 — 斗鱼弹幕文本协议
 * 移植自 biliup crates/danmaku/src/codec/stt.rs
 *
 * 格式: key@=value/ 键值对, 嵌套结构递归解析;
 * 转义: @A → @, @S → /
 *
 * 用 Map 承载键值对 (而非普通对象), 避免协议数据中的
 * __proto__ 等键触发原型链污染。
 */

export type SttValue = string | Map<string, SttValue> | SttValue[];

/** 解码 STT 文本为嵌套结构 */
export function decode(input: string): SttValue {
  if (input.includes('/')) {
    const items = input.split('/').filter((s) => s !== '');
    const dict = new Map<string, SttValue>();
    const list: SttValue[] = [];
    for (const item of items) {
      const decoded = decode(item);
      if (decoded instanceof Map) {
        for (const [k, v] of decoded) dict.set(k, v);
      } else {
        list.push(decoded);
      }
    }
    return list.length > 0 ? list : dict;
  }
  if (input.includes('@=')) {
    const idx = input.indexOf('@=');
    const key = decodeString(input.slice(0, idx));
    const value = decode(input.slice(idx + 2));
    return new Map([[key, value]]);
  }
  return decodeString(input);
}

/** 解码 @A / @S 转义 */
export function decodeString(s: string): string {
  return s.replace(/@A/g, '@').replace(/@S/g, '/');
}

/** 从解码结果中按键取字符串值 */
export function getStr(value: SttValue, key: string): string | undefined {
  if (value instanceof Map) {
    const v = value.get(key);
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}
