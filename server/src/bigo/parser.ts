/**
 * Bigo Live URL 解析器
 * 移植自 biliup crates/biliup/src/downloader/live/bigo.rs
 * 适配 CaptureHub 的 LiveInfo / Streamer 接口
 */
import { fetchStudioInfo } from './api.js';
import type { BigoStudioData } from './types.js';
import type { LiveInfo, RecordQuality } from '../types.js';

export class BigoParser {
  readonly platform = 'bigo';
  readonly siteURL = 'https://www.bigo.tv/';
  static readonly matchPattern = /bigo\.tv/;

  matchURL(url: string): boolean {
    return (
      /https?:\/\/(?:.*?\.)?bigo\.tv\//.test(url) ||
      BigoParser.matchPattern.test(url)
    );
  }

  /** 从 URL 提取 siteId (https://www.bigo.tv/{siteId}) */
  extractSiteId(url: string): string | null {
    const m = url.trim().match(/bigo\.tv\/([^/?#]+)/i);
    if (!m) return null;
    const id = decodeURIComponent(m[1]).trim();
    return id || null;
  }

  /** 拉取直播间信息 (code=0 且 data 存在) */
  private async fetchInfo(siteId: string): Promise<BigoStudioData | null> {
    const resp = await fetchStudioInfo(siteId);
    if (resp.code !== 0 || !resp.data) return null;
    return resp.data;
  }

  /**
   * 从链接解析主播信息
   * 支持 www.bigo.tv/{siteId}
   */
  async resolveFromProfileUrl(url: string): Promise<{
    userId: string;
    redId: string | null;
    name: string;
    avatar: string;
    roomId: string | null;
    living: boolean;
    title: string;
  }> {
    const siteId = this.extractSiteId(url);
    if (!siteId) throw new Error('无法从链接解析出 Bigo 用户 ID');

    try {
      const data = await this.fetchInfo(siteId);
      const living = !!data && data.alive === 1 && !!data.hls_src;
      const name =
        (data?.nick_name && String(data.nick_name)) ||
        (data?.roomTopic && String(data.roomTopic)) ||
        siteId;
      return {
        userId: siteId,
        redId: null,
        name,
        avatar: data?.avatar || '',
        // siteId 是稳定标识, 离线时也保留以复用监控
        roomId: siteId,
        living,
        title: data?.roomTopic || '',
      };
    } catch {
      // API 失败时返回基础信息, 由后续监控轮询重试
      return {
        userId: siteId,
        redId: null,
        name: siteId,
        avatar: '',
        roomId: siteId,
        living: false,
        title: '',
      };
    }
  }

  /** 获取房间信息 (返回 CaptureHub 的 LiveInfo 类型) */
  async getRoomInfo(siteId: string): Promise<LiveInfo> {
    const data = await this.fetchInfo(siteId);
    if (!data) {
      return {
        living: false,
        roomId: siteId,
        title: '',
        owner: '',
        avatar: '',
        cover: '',
      };
    }
    const living = data.alive === 1 && !!data.hls_src;
    // 离线时 roomId 为 "0", 回退使用 siteId
    const realRoomId =
      data.roomId && String(data.roomId) !== '0' ? String(data.roomId) : siteId;
    return {
      living,
      roomId: realRoomId,
      title: data.roomTopic || '',
      owner: (data.nick_name && String(data.nick_name)) || '',
      avatar: data.avatar || '',
      cover: '',
      m3u8Url: living ? (data.hls_src as string) : undefined,
    };
  }

  /**
   * 获取流地址 (Bigo 仅 HLS 单流, 无画质分档)
   */
  async getStreams(
    siteId: string,
    _format: Array<'flv' | 'hls'> = ['hls'],
    _quality?: string | RecordQuality,
  ): Promise<
    Array<{
      name: string;
      streams: Array<{ url: string; quality: string; format: 'flv' | 'hls' }>;
    }>
  > {
    const data = await this.fetchInfo(siteId);
    if (!data || data.alive !== 1 || !data.hls_src) {
      throw new Error('Bigo 直播间未开播');
    }
    return [
      {
        name: '自动',
        streams: [{ url: data.hls_src, quality: 'OD', format: 'hls' }],
      },
    ];
  }
}
