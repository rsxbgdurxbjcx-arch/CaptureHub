/**
 * Stripchat URL 解析器
 * 移植自 StripchatRecorder 的 stripchat 拉流逻辑
 * 适配 CaptureHub 的 LiveInfo / Streamer 接口
 */
import { getInfo, getStream, getInfoAndStream } from './stream.js';
import { fetchCamInfo } from './api.js';
import type { LiveInfo, RecordQuality } from '../types.js';

export class StripchatParser {
  readonly platform = 'stripchat';
  readonly siteURL = 'https://stripchat.com/';
  static readonly matchPattern = /stripchat\.com/;

  private cookie?: string;
  private mouflonKeys?: Record<string, string>;

  constructor(options?: {
    cookie?: string;
    mouflonKeys?: Record<string, string>;
  }) {
    this.cookie = options?.cookie;
    this.mouflonKeys = options?.mouflonKeys;
  }

  matchURL(url: string): boolean {
    return /https?:\/\/(?:.*?\.)?stripchat\.com\//.test(url) ||
      StripchatParser.matchPattern.test(url);
  }

  /**
   * 从 URL 提取 Stripchat 主播用户名 (username)
   * 支持的 URL 格式:
   * - https://stripchat.com/{username}          → 主播主页
   * - https://stripchat.com/{username}/myRoom   → 直播间
   * - https://stripchat.com/{username}/{...}
   */
  extractUsername(url: string): string | null {
    url = url.trim();
    const m = url.match(/stripchat\.com\/([^/?#]+)/i);
    if (!m) return null;
    const seg = decodeURIComponent(m[1]);
    // 排除明显的非主播路径段
    const reserved = new Set([
      'api', 'girls', 'boys', 'couples', 'trans', 'vr', 'categories',
      'tags', 'live', 'search', 'favorites', 'login', 'signup', 'auth',
    ]);
    if (!seg || reserved.has(seg.toLowerCase())) return null;
    return seg;
  }

  /**
   * 从链接解析主播信息
   */
  async resolveFromProfileUrl(
    url: string,
    cookieStr?: string,
  ): Promise<{
    userId: string;
    redId: string | null;
    name: string;
    avatar: string;
    roomId: string | null;
    living: boolean;
    title: string;
  }> {
    const username = this.extractUsername(url);
    if (!username) throw new Error('无法从链接解析出 Stripchat 主播用户名 (username)');

    const cookie = cookieStr ?? this.cookie;

    try {
      const info = await getInfo(username, {
        cookie,
        mouflonKeys: this.mouflonKeys,
      });
      return {
        userId: username,
        redId: null,
        name: username,
        avatar: info.avatar,
        roomId: username,
        living: info.living,
        title: info.title || '',
      };
    } catch {
      // API 失败时, 返回基础信息
      return {
        userId: username,
        redId: null,
        name: username,
        avatar: '',
        roomId: username,
        living: false,
        title: '',
      };
    }
  }

  /** 获取房间信息 (返回 CaptureHub 的 LiveInfo 类型) */
  async getRoomInfo(username: string): Promise<LiveInfo> {
    const { info, stream } = await getInfoAndStream(username, {
      cookie: this.cookie,
      mouflonKeys: this.mouflonKeys,
    });

    return {
      living: info.living,
      roomId: info.roomId,
      title: info.title,
      owner: info.owner,
      avatar: info.avatar,
      cover: info.cover,
      m3u8Url: stream?.url,
    };
  }

  /**
   * 获取流地址
   * 默认请求最高画质 (OD=原画), 画质不匹配时自动降级
   *
   * @param username 主播用户名
   * @param _format  输出格式 (Stripchat 仅支持 HLS)
   * @param quality  期望画质 (OD/UHD/HD/SD/LD), 默认 OD
   */
  async getStreams(
    username: string,
    _format: Array<'flv' | 'hls'> = ['hls'],
    quality?: string | RecordQuality,
  ): Promise<
    Array<{
      name: string;
      streams: Array<{ url: string; quality: string; format: 'flv' | 'hls' }>;
    }>
  > {
    const stream = await getStream({
      username,
      quality: quality || 'OD',
      cookie: this.cookie,
      mouflonKeys: this.mouflonKeys,
    });

    return [
      {
        name: '自动',
        streams: [
          { url: stream.url, quality: stream.name, format: 'hls' },
        ],
      },
    ];
  }
}

export { getInfo, getStream, getInfoAndStream, fetchCamInfo };
