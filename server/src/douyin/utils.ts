/**
 * assert 辅助函数
 */
export function assert(assertion: unknown, msg?: string): asserts assertion {
  if (!assertion) {
    throw new Error(msg);
  }
}

export function assertStringType(data: unknown, msg?: string): asserts data is string {
  assert(typeof data === "string", msg);
}

export function assertNumberType(data: unknown, msg?: string): asserts data is number {
  assert(typeof data === "number", msg);
}

export function assertObjectType(data: unknown, msg?: string): asserts data is object {
  assert(typeof data === "object", msg);
}

/**
 * get__ac_signature - 纯JS实现，无外部依赖
 * 用于生成抖音 __ac_signature cookie 值
 *
 * @param one_time_stamp 时间戳（秒）
 * @param one_site 站点URL，提取自 window.location.href
 * @param one_nonce 随机nonce值
 * @param ua_n User-Agent 字符串
 * @returns 签名字符串
 */
export function get__ac_signature(
  one_time_stamp: number,
  one_site: string,
  one_nonce: string,
  ua_n: string,
): string {
  function cal_one_str(one_str: string, orgi_iv: number): number {
    let k = orgi_iv;
    for (let i = 0; i < one_str.length; i++) {
      const a = one_str.charCodeAt(i);
      k = ((k ^ a) * 65599) >>> 0;
    }
    return k;
  }

  function cal_one_str_3(one_str: string, orgi_iv: number): number {
    // 用于计算后两位
    let k = orgi_iv;
    for (let i = 0; i < one_str.length; i++) {
      k = (k * 65599 + one_str.charCodeAt(i)) >>> 0;
    }
    return k;
  }

  function get_one_chr(enc_chr_code: number): string {
    if (enc_chr_code < 26) {
      return String.fromCharCode(enc_chr_code + 65);
    } else if (enc_chr_code < 52) {
      return String.fromCharCode(enc_chr_code + 71);
    } else if (enc_chr_code < 62) {
      return String.fromCharCode(enc_chr_code - 4);
    } else {
      return String.fromCharCode(enc_chr_code - 17);
    }
  }

  function enc_num_to_str(one_orgi_enc: number): string {
    let s = "";
    for (let i = 24; i >= 0; i -= 6) {
      s += get_one_chr((one_orgi_enc >> i) & 63);
    }
    return s;
  }

  const sign_head = "_02B4Z6wo00f01";
  const time_stamp_s = one_time_stamp + "";

  const a = cal_one_str(one_site, cal_one_str(time_stamp_s, 0)) % 65521;
  const b = parseInt(
    "10000000110000" +
      parseInt(String((one_time_stamp ^ (a * 65521)) >>> 0))
        .toString(2)
        .padStart(32, "0"),
    2,
  );
  const b_s = b + "";
  const c = cal_one_str(b_s, 0);
  const d = enc_num_to_str(b >> 2);
  const e = (b / 4294967296) >>> 0;
  const f = enc_num_to_str((b << 28) | (e >>> 4));
  const g = 582085784 ^ b;
  const h = enc_num_to_str((e << 26) | (g >>> 6));
  const i = get_one_chr(g & 63);
  const j =
    (cal_one_str(ua_n, c) % 65521 << 16) | (cal_one_str(one_nonce, c) % 65521);
  const k = enc_num_to_str(j >> 2);
  const l = enc_num_to_str((j << 28) | ((524576 ^ b) >>> 4));
  const m = enc_num_to_str(a);
  const n = sign_head + d + f + h + i + k + l + m;
  const o = parseInt(String(cal_one_str_3(n, 0))).toString(16).slice(-2);
  const signature = n + o;
  return signature;
}
