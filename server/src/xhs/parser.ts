import { HttpClient } from './http.js';
import { getXhsStreamUrl, getUserInfo, userSearch, parseUserSearchLive, extractLiveFromProfileState } from './api.js';
import type { LiveInfo } from '../types.js';

export class XhsParser {
  readonly platform = 'xhs';
  readonly siteURL = 'https://www.xiaohongshu.com/';
  static readonly matchPattern = /xiaohongshu\.com|xhslink\.com/;

  private http: HttpClient;

  constructor(options?: { cookie?: string; proxy?: string }) {
    this.http = new HttpClient(options);
  }

  matchURL(url: string): boolean {
    return XhsParser.matchPattern.test(url);
  }

  /**
   * 解析短链 / 直播页 / 主页链接
   * - livestream URL / 短链 → roomId + host_id(userId)
   * - user/profile URL → userId
   */
  async extractUrl(url: string): Promise<{
    roomId: string | null;
    userId: string | null;
    kind: 'live' | 'profile' | 'unknown';
  }> {
    url = url.trim();

    // 短链：fetch 已跟随 HTTP 重定向，response.url 即为最终地址
    if (url.includes('xhslink.com')) {
      try {
        const response = await this.http.request(url, {});
        let finalUrl = response.url || url;

        // 少数情况：xhslink 返回 200 + meta refresh 而非 HTTP 重定向
        if (finalUrl.includes('xhslink.com')) {
          try {
            const html = await response.text();
            // meta refresh: <meta http-equiv="refresh" content="0;url=...">
            const metaMatch = html.match(
              /(?:content|href|url)=["'](https?:\/\/www\.xiaohongshu\.com\/[^"'\s]+)["']/i,
            );
            if (metaMatch) {
              finalUrl = metaMatch[1];
            }
            // 也尝试从普通链接提取
            if (finalUrl.includes('xhslink.com')) {
              const linkMatch = html.match(
                /https?:\/\/www\.xiaohongshu\.com\/(?:user\/profile\/|livestream\/|explore\/)[^\s"'<]+/i,
              );
              if (linkMatch) {
                finalUrl = linkMatch[0];
              }
            }
          } catch {
            // 如果 response.text() 失败，尝试用 getText
            try {
              const html = await this.http.getText(url);
              const metaMatch = html.match(
                /(?:content|href|url)=["'](https?:\/\/www\.xiaohongshu\.com\/[^"'\s]+)["']/i,
              );
              if (metaMatch) {
                finalUrl = metaMatch[1];
              }
            } catch {
              // 两次尝试均失败
            }
          }
        }

        // 仍未解析成功则抛出明确错误
        if (finalUrl.includes('xhslink.com')) {
          throw new Error(
            '短链接重定向后仍为 xhslink.com，无法获取真实地址。请确认链接有效，或直接使用 xiaohongshu.com 主页链接。',
          );
        }

        return this.extractUrl(finalUrl);
      } catch (error) {
        throw new Error(`无法解析短链接: ${(error as Error).message}`);
      }
    }

    if (!/xiaohongshu\.com/.test(url)) {
      throw new Error(`不支持的 URL: ${url}`);
    }

    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(Boolean);

    // /livestream/{roomId}
    if (parts[0] === 'livestream') {
      return {
        roomId: parts[1] || null,
        userId: urlObj.searchParams.get('host_id'),
        kind: 'live',
      };
    }

    // /user/profile/{userId}
    if (parts[0] === 'user' && parts[1] === 'profile') {
      return {
        roomId: null,
        userId: parts[2] || null,
        kind: 'profile',
      };
    }

    // /explore/{id}?xsec_token=...  (分享链接的一种变体)
    if (parts[0] === 'explore' && parts[1]) {
      return {
        roomId: null,
        userId: null,
        kind: 'unknown',
      };
    }

    // 兜底：路径最后一段
    return {
      roomId: parts[parts.length - 1] || null,
      userId: urlObj.searchParams.get('host_id'),
      kind: 'unknown',
    };
  }

  async extractRoomId(url: string): Promise<string> {
    const { roomId } = await this.extractUrl(url);
    if (!roomId) throw new Error(`无法从 URL 提取房间 ID: ${url}`);
    return roomId;
  }

  async extractUserId(url: string): Promise<string | null> {
    const { userId } = await this.extractUrl(url);
    return userId;
  }

  async checkLiveByRedId(redId: string, cookieStr: string) {
    const response = await userSearch(this.http, redId, cookieStr);
    return parseUserSearchLive(response, redId);
  }

  /**
   * 回退检测：通过用户主页页面判断是否在直播（不依赖 usersearch 签名）
   * 在 cookie 签名失效时作为备用方案
   */
  async checkLiveFromProfilePage(userId: string): Promise<{
    living: boolean;
    roomId: string | null;
    owner: string;
    avatar: string;
    title: string;
  }> {
    const data = await getUserInfo(this.http, userId);
    const basic = data?.user?.userPageData?.basicInfo;
    const { living, roomId, title } = extractLiveFromProfileState(data);
    return {
      living,
      roomId,
      owner: basic?.nickname || '',
      avatar: basic?.images || '',
      title,
    };
  }

  async getUserProfile(uid: string) {
    const data = await getUserInfo(this.http, uid);
    const basic = data?.user?.userPageData?.basicInfo;
    return {
      redId: basic?.redId || null,
      nickname: basic?.nickname || '',
      avatar: basic?.images || '',
      raw: data,
    };
  }

  async getRoomInfo(roomId: string): Promise<LiveInfo> {
    const streamInfo = await getXhsStreamUrl(this.http, roomId);
    return {
      living: streamInfo.is_live,
      roomId: streamInfo.room_id || roomId,
      title: streamInfo.title || '',
      owner: streamInfo.anchor_name || '',
      avatar: streamInfo.avatar || '',
      cover: streamInfo.cover || '',
      flvUrl: streamInfo.flv_url,
      m3u8Url: streamInfo.m3u8_url,
    };
  }

  async getStreams(
    roomId: string,
    format: Array<'flv' | 'hls'> = ['flv', 'hls'],
  ) {
    const streamInfo = await getXhsStreamUrl(this.http, roomId);
    if (!streamInfo.is_live) return [];

    const streams: Array<{
      url: string;
      quality: string;
      format: 'flv' | 'hls';
    }> = [];

    if (format.includes('flv') && streamInfo.flv_url) {
      streams.push({
        url: streamInfo.flv_url,
        quality: '原画',
        format: 'flv',
      });
    }
    if (format.includes('hls') && streamInfo.m3u8_url) {
      streams.push({
        url: streamInfo.m3u8_url,
        quality: '原画',
        format: 'hls',
      });
    }

    return streams.length
      ? [{ name: '默认线路', streams }]
      : [];
  }

  /**
   * 从任意链接解析主播基础信息
   * 支持：主页链接、直播链接、分享短链、explore 链接
   */
  async resolveFromProfileUrl(
    profileUrl: string,
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
    const extracted = await this.extractUrl(profileUrl);

    // 直播链接：直接拉流信息
    if (extracted.kind === 'live' && extracted.roomId) {
      const info = await this.getRoomInfo(extracted.roomId);
      let redId: string | null = null;
      if (extracted.userId) {
        try {
          const profile = await this.getUserProfile(extracted.userId);
          redId = profile.redId;
        } catch {
          // ignore
        }
      }
      return {
        userId: extracted.userId || extracted.roomId,
        redId,
        name: info.owner || '未知主播',
        avatar: info.avatar,
        roomId: info.roomId,
        living: info.living,
        title: info.title,
      };
    }

    // 主页链接或短链 → 通过页面内容提取用户信息
    let userId = extracted.userId;
    const pageUrl = extracted.userId
      ? `https://www.xiaohongshu.com/user/profile/${extracted.userId}`
      : profileUrl;

    // 对短链和 explore 链接，直接从原始 URL 拉取页面内容提取 userId
    if (!userId) {
      try {
        const html = await this.http.getText(pageUrl, {
          headers: { referer: 'https://www.xiaohongshu.com/' },
        });
        // 从页面 HTML 中提取 userId
        const urlUserIdMatch =
          html.match(/"userId"\s*:\s*"([a-f0-9]+)"/i) ||
          html.match(/user\/profile\/([a-f0-9]+)/i);
        if (urlUserIdMatch) {
          userId = urlUserIdMatch[1];
        }
      } catch {
        // ignore
      }
    }

    if (!userId) {
      throw new Error('无法从链接提取用户 ID，请使用主页链接（user/profile/xxx）或直播链接');
    }

    const profile = await this.getUserProfile(userId);
    let living = false;
    let roomId: string | null = null;
    let title = '';
    let name = profile.nickname || '未知主播';
    let avatar = profile.avatar;

    // 先从用户主页页面检测直播状态（不依赖 cookie 签名，最可靠）
    try {
      const profileLive = await this.checkLiveFromProfilePage(userId);
      if (profileLive.living && profileLive.roomId) {
        living = true;
        roomId = profileLive.roomId;
        title = profileLive.title;
        if (profileLive.owner) name = profileLive.owner;
        if (profileLive.avatar) avatar = profileLive.avatar;
      }
    } catch {
      // profile check is non-critical
    }

    // Cookie + redId → usersearch 增强检测（仅在 profile 未检测到直播时尝试）
    if (!living && cookieStr && profile.redId) {
      try {
        const live = await this.checkLiveByRedId(profile.redId, cookieStr);
        living = live.living;
        roomId = live.roomId || roomId;
        name = live.owner || name;
        avatar = live.avatar || avatar;
        if (living && roomId) {
          try {
            const room = await this.getRoomInfo(roomId);
            title = room.title || title;
            if (room.owner) name = room.owner;
            if (room.avatar) avatar = room.avatar;
          } catch {
            // ignore room detail error
          }
        }
      } catch {
        // usersearch 不可用，profile 页面检测结果已足够
      }
    }

    return {
      userId,
      redId: profile.redId,
      name,
      avatar,
      roomId,
      living,
      title,
    };
  }
}

export { getXhsStreamUrl, userSearch, getUserInfo };
