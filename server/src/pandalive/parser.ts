/**
 * Pandalive URL 解析器
 * 移植自 StreamCap/StreamGet 的 Pandalive 解析逻辑
 * 适配 red 项目的 LiveInfo / Streamer 接口
 */
import { getInfo, getStream, getInfoAndStream } from "./stream.js";
import { fetchMemberInfo } from "./api.js";
import type { LiveInfo, RecordQuality } from "../types.js";

export class PandaliveParser {
  readonly platform = "pandalive";
  readonly siteURL = "https://www.pandalive.co.kr/";
  static readonly matchPattern = /pandalive\.co\.kr/;

  private cookie?: string;

  constructor(options?: { cookie?: string }) {
    this.cookie = options?.cookie;
  }

  matchURL(url: string): boolean {
    return (
      /https?:\/\/(?:.*?\.)?pandalive\.co\.kr\//.test(url) ||
      PandaliveParser.matchPattern.test(url)
    );
  }

  /**
   * 从 URL 提取 Pandalive 用户 ID (userId)
   * 支持的 URL 格式 (与 StreamGet 一致，取 URL 最后一段路径作为 userId):
   * - https://www.pandalive.co.kr/live/play/{userId}  → 直播间 (StreamCap 格式)
   * - https://www.pandalive.co.kr/live/{userId}       → 直播间
   * - https://www.pandalive.co.kr/{userId}             → 主播主页
   * - https://api.pandalive.co.kr/v1/member/bj?userId={userId}
   */
  extractUserId(url: string): string | null {
    url = url.trim();
    // api.pandalive.co.kr/v1/member/bj?userId={userId}
    const m = url.match(/[?&]userId=([^&#]+)/);
    if (m) return m[1];
    // 取 URL 路径最后一段作为 userId (与 StreamGet 的 rsplit('/', 1)[1] 一致)
    const pathPart = url.split('?')[0].split('#')[0];
    const segments = pathPart.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    const last = segments[segments.length - 1];
    // 排除明显的非 userId 路径段
    if (['live', 'play', 'api', 'v1', 'member', 'bj'].includes(last)) return null;
    return decodeURIComponent(last);
  }

  /**
   * 从链接解析主播信息
   * 支持 www.pandalive.co.kr/{userId}
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
    const userId = this.extractUserId(url);
    if (!userId)
      throw new Error("无法从链接解析出 Pandalive 用户ID (userId)");

    const cookie = cookieStr ?? this.cookie;

    try {
      const info = await getInfo(userId, { cookie });
      return {
        userId,
        redId: null,
        name: info.owner || "未知主播",
        avatar: info.avatar,
        roomId: info.living ? userId : null,
        living: info.living,
        title: info.title || "",
      };
    } catch {
      // API 失败时，返回基础信息
      return {
        userId,
        redId: null,
        name: "未知主播",
        avatar: "",
        roomId: null,
        living: false,
        title: "",
      };
    }
  }

  /** 获取房间信息（返回 red 项目的 LiveInfo 类型） */
  async getRoomInfo(userId: string): Promise<LiveInfo> {
    const { info, stream } = await getInfoAndStream(userId, {
      cookie: this.cookie,
    });

    let m3u8Url: string | undefined;
    if (stream?.url) {
      m3u8Url = stream.url;
    }

    return {
      living: info.living,
      roomId: info.roomId,
      title: info.title,
      owner: info.owner,
      avatar: info.avatar,
      cover: info.cover,
      m3u8Url,
    };
  }

  /**
   * 获取流地址
   * 默认请求最高画质（OD=原画），画质不匹配时自动降级
   *
   * @param userId  主播 ID
   * @param _format 输出格式（Pandalive 仅支持 HLS）
   * @param quality 期望画质 (OD/UHD/HD/SD/LD)，默认 OD
   */
  async getStreams(
    userId: string,
    _format: Array<"flv" | "hls"> = ["hls"],
    quality?: string | RecordQuality,
  ): Promise<
    Array<{
      name: string;
      streams: Array<{ url: string; quality: string; format: "flv" | "hls" }>;
    }>
  > {
    const stream = await getStream({
      userId,
      quality: quality || "OD",
      cookie: this.cookie,
    });

    return [
      {
        name: "自动",
        streams: [
          { url: stream.url, quality: stream.name, format: "hls" },
        ],
      },
    ];
  }
}

export { getInfo, getStream, getInfoAndStream, fetchMemberInfo };
