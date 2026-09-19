/**
 * 各平台直播流 CDN 浏览器特征请求头 — 录制(recorder)与快照(streamers)共用
 *
 * 部分平台 CDN 对 FLV/HLS 拉流校验 Referer/Origin/UA(甚至会话 Cookie):
 * - 缺失时直接 403(B 站 pt=html5 流的部分节点、Pandalive 登录保护流);
 * - 或数秒内被服务端掐断(虎牙 FLV 长连接)。
 *
 * 返回可直接展开进 ffmpeg 参数数组的 ['-headers', '...'](无头时为空数组)。
 * 统一在此构造, 避免录制与快照两处逻辑漂移。
 */
import type { Platform, Settings } from '../types.js';

export function buildPlatformHeaderArgs(
  platform: Platform | undefined,
  settings: Settings,
): string[] {
  const headerLines: string[] = [];

  if (platform === 'pandalive') {
    // Pandalive:流地址(尤其成人/登录保护的流)需要携带会话 Cookie 与 Referer/Origin/UA
    const cookie = (settings.cookiePandalive || settings.cookie || '').replace(/[\r\n]+/g, '');
    headerLines.push(
      'Referer: https://www.pandalive.co.kr/',
      'Origin: https://www.pandalive.co.kr',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    );
    if (cookie) {
      headerLines.push(`Cookie: ${cookie}`);
    }
  } else if (platform === 'stripchat') {
    // Stripchat:CDN HLS 分片需要携带 Referer 与浏览器 UA
    headerLines.push(
      'Referer: https://stripchat.com/',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    );
  } else if (platform === 'huya') {
    // 虎牙:FLV 长连接校验浏览器特征头, 缺失时数秒内即被掐断
    headerLines.push(
      'Referer: https://www.huya.com/',
      'Origin: https://www.huya.com',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept: */*',
    );
  } else if (platform === 'bilibili') {
    // B 站:pt=html5 的 FLV 流部分 CDN 节点校验浏览器特征头, 缺失时直接 403
    // (与 biliup 上游 stream_headers 保持一致)
    headerLines.push(
      'Referer: https://live.bilibili.com',
      'Origin: https://live.bilibili.com',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
  }

  if (headerLines.length === 0) return [];
  return ['-headers', `${headerLines.join('\r\n')}\r\n`];
}
