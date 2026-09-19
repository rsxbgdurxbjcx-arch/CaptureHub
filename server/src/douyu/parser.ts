/**
 * 斗鱼 URL 解析器
 * 移植自 biliup crates/biliup/src/downloader/live/douyu.rs
 * 适配 CaptureHub 的 LiveInfo / Streamer 接口
 */
import { resolveRealRoomId } from './api.js';
import { getInfo, getInfoAndStream, getStream } from './stream.js';
import type { LiveInfo, RecordQuality } from '../types.js';

export class DouyuParser {
  readonly platform = 'douyu';
  readonly siteURL = 'https://www.douyu.com/';
  static readonly matchPattern = /douyu\.com/;

  matchURL(url: string): boolean {
    return (
      /https?:\/\/(?:(?:www|m)\.)?douyu\.com\//.test(url) ||
      DouyuParser.matchPattern.test(url)
    );
  }

  /**
   * 从链接解析主播信息
   * 支持 www.douyu.com/{房间号或别名} / m.douyu.com/{房间号}
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
    const roomId = await resolveRealRoomId(url);

    // 房间信息拉取失败不阻塞添加, 由后续监控轮询重试
    let info: Awaited<ReturnType<typeof getInfo>> | null = null;
    try {
      info = await getInfo(roomId);
    } catch {
      info = null;
    }

    return {
      userId: roomId,
      redId: null,
      name: info?.owner || roomId,
      avatar: info?.avatar || '',
      // 真实房间号是稳定标识, 离线时也保留
      roomId,
      living: info?.living ?? false,
      title: info?.title || '',
    };
  }

  /** 获取房间信息 (在播时附带拉流地址, 供快照与开录使用) */
  async getRoomInfo(roomId: string): Promise<LiveInfo> {
    const { info, stream } = await getInfoAndStream(roomId);
    return {
      living: info.living,
      roomId,
      title: info.title,
      owner: info.owner,
      avatar: info.avatar,
      cover: '',
      flvUrl: stream?.url,
    };
  }

  /**
   * 获取流地址 (斗鱼 rate 固定 0 原画, 画质参数不生效 — 与 biliup 一致)
   */
  async getStreams(
    roomId: string,
    _format: Array<'flv' | 'hls'> = ['flv', 'hls'],
    _quality?: string | RecordQuality,
  ): Promise<
    Array<{
      name: string;
      streams: Array<{ url: string; quality: string; format: 'flv' | 'hls' }>;
    }>
  > {
    const stream = await getStream(roomId);
    return [
      {
        name: '自动',
        streams: [{ url: stream.url, quality: 'OD', format: 'flv' }],
      },
    ];
  }
}
