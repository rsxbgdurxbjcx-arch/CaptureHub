/**
 * Bigo Live 直播 API 层
 * 移植自 biliup crates/biliup/src/downloader/live/bigo.rs
 *
 * 单接口: POST https://ta.bigo.tv/official_website/studio/getInternalStudioInfo
 * (form: siteId={roomId}), code=0 且 data.alive=1 且 hls_src 非空视为在播。
 */
import { fetch as undiciFetch } from 'undici';
import type { BigoStudioInfoResponse } from './types.js';

const API_URL = 'https://ta.bigo.tv/official_website/studio/getInternalStudioInfo';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function fetchStudioInfo(siteId: string): Promise<BigoStudioInfoResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const body = new URLSearchParams({ siteId }).toString();
    const resp = await undiciFetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': DEFAULT_UA,
      },
      body,
      signal: controller.signal,
    });
    return (await resp.json()) as BigoStudioInfoResponse;
  } finally {
    clearTimeout(timer);
  }
}
