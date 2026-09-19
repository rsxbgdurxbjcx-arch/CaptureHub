import { fetch, ProxyAgent, Agent } from 'undici';
import type { Response } from 'undici';
import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';

const decompressors = {
  br: promisify(brotliDecompress),
  deflate: promisify(inflate),
  gzip: promisify(gunzip),
} as const;

export interface RequestOptions {
  cookie?: string;
  headers?: Record<string, string>;
  timeout?: number;
  proxy?: string;
  method?: string;
  body?: string;
}

async function decodeTextBody(
  body: ArrayBuffer,
  contentEncoding?: string | string[],
): Promise<string> {
  let data: Buffer = Buffer.from(body);
  const encodings = (
    Array.isArray(contentEncoding) ? contentEncoding.join(',') : contentEncoding
  )
    ?.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== 'identity');

  for (const encoding of (encodings ?? []).reverse()) {
    const decompress = decompressors[encoding as keyof typeof decompressors];
    if (!decompress) {
      throw new Error(`不支持的响应压缩格式: ${encoding}`);
    }
    data = await decompress(data);
  }
  return data.toString('utf8');
}

/** 将所有来源的 cookie 合并为 Cookie 请求头 */
function buildCookie(cookie?: string, headers?: Record<string, string>): string | null {
  const fromCookie = cookie?.trim();
  // headers 中可能也有 cookie/Cookie 键（大小写不敏感），统一合并
  let fromHeaders = '';
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === 'cookie') {
      fromHeaders = (headers![key] || '').trim();
      break;
    }
  }
  if (!fromCookie && !fromHeaders) return null;
  if (fromCookie && fromHeaders) {
    // 合并去重：先 cookie 参数，再 headers 中的
    const existingKeys = new Set(
      fromHeaders.split(';').map((s) => s.split('=')[0]?.trim()).filter(Boolean),
    );
    const extraParts = fromCookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !existingKeys.has(s.split('=')[0]?.trim()));
    return [...(extraParts.length ? extraParts : []), fromHeaders].join('; ');
  }
  return fromCookie || fromHeaders;
}

export class HttpClient {
  private dispatcher?: Agent | ProxyAgent;

  constructor(private defaultOptions?: RequestOptions) {
    if (defaultOptions?.proxy) {
      this.dispatcher = new ProxyAgent(defaultOptions.proxy);
    }
  }

  private getDispatcher(proxy?: string) {
    if (proxy) return new ProxyAgent(proxy);
    return this.dispatcher;
  }

  /** 过滤掉 headers 中的 cookie/Cookie 键，避免和 buildCookie 冲突 */
  private stripCookie(headers?: Record<string, string>): Record<string, string> {
    if (!headers) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() !== 'cookie') out[k] = v;
    }
    return out;
  }

  /** 返回标准 Response（已跟随重定向），response.url 为最终地址 */
  async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const merged = { ...this.defaultOptions, ...options };
    try {
      const cookieVal = buildCookie(merged.cookie, merged.headers);
      const resp = await fetch(url, {
        method: (merged.method as 'GET' | 'POST') || 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...(cookieVal ? { Cookie: cookieVal } : {}),
          ...this.stripCookie(merged.headers),
        },
        body: merged.body,
        dispatcher: this.getDispatcher(merged.proxy) as any,
        redirect: 'follow',
      });
      return resp;
    } catch (error) {
      throw new Error(`请求失败: ${(error as Error).message}`);
    }
  }

  async getText(url: string, opts?: RequestOptions): Promise<string> {
    const merged = { ...this.defaultOptions, ...opts };
    try {
      const cookieVal = buildCookie(merged.cookie, merged.headers);
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
          ...(cookieVal ? { Cookie: cookieVal } : {}),
          ...this.stripCookie(merged.headers),
        },
        dispatcher: this.getDispatcher(merged.proxy) as any,
        redirect: 'follow',
      });
      const body = await resp.arrayBuffer();
      return await decodeTextBody(body, resp.headers.get('content-encoding') ?? undefined);
    } catch (error) {
      throw new Error(`请求失败: ${(error as Error).message}`);
    }
  }

  async postJson<T = unknown>(
    url: string,
    body: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const merged = { ...this.defaultOptions, ...opts };
    try {
      const cookieVal = buildCookie(merged.cookie, merged.headers);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/json',
          ...(cookieVal ? { Cookie: cookieVal } : {}),
          ...this.stripCookie(merged.headers),
        },
        body: JSON.stringify(body),
        dispatcher: this.getDispatcher(merged.proxy) as any,
        redirect: 'follow',
      });
      return (await resp.json()) as T;
    } catch (error) {
      throw new Error(`请求失败: ${(error as Error).message}`);
    }
  }
}
