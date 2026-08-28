/**
 * SOOP (formerly AfreecaTV) URL 解析器
 * 移植自 streamget 的 SOOP 模块
 * 适配 red 项目的 LiveInfo / Streamer 接口
 */
import { getInfo, getStream, getInfoAndStream } from "./stream.js";
import { fetchStationStatus } from "./api.js";
import type { LiveInfo, RecordQuality } from "../types.js";

export class SoopParser {
  readonly platform = "soop";
  readonly siteURL = "https://www.sooplive.com/";
  static readonly matchPattern = /sooplive\.com|afreecatv\.com/;

  private cookie?: string;
  private username?: string;
  private password?: string;

  constructor(options?: {
    cookie?: string;
    username?: string;
    password?: string;
  }) {
    this.cookie = options?.cookie;
    this.username = options?.username;
    this.password = options?.password;
  }

  matchURL(url: string): boolean {
    return (
      /https?:\/\/(?:.*?\.)?sooplive\.(com|co\.kr)\//.test(url) ||
      /https?:\/\/(?:.*?\.)?afreecatv\.com\//.test(url) ||
      SoopParser.matchPattern.test(url)
    );
  }

  /**
   * 从 URL 提取 SOOP 主播 ID (bjId)
   * 支持的 URL 格式：
   * - https://play.sooplive.com/{bjId}/{bno}   → 直播间
   * - https://play.sooplive.co.kr/{bjId}/{bno} → 直播间
   * - https://www.sooplive.com/{bjId}           → 主播主页
   * - https://www.afreecatv.com/{bjId}          → 主播主页
   * - https://play.afreecatv.com/{bjId}/{bno}   → 直播间
   */
  extractBjId(url: string): string | null {
    url = url.trim();
    // play.sooplive.com/{bjId}/{bno} 或 play.sooplive.com/{bjId}
    const m = url.match(
      /play\.sooplive\.(?:com|co\.kr)\/([^/?#]+)/,
    );
    if (m) return m[1];
    // play.afreecatv.com/{bjId}/{bno}
    const m2 = url.match(/play\.afreecatv\.com\/([^/?#]+)/);
    if (m2) return m2[1];
    // www.sooplive.com/{bjId} 或 sooplive.com/{bjId}
    const m3 = url.match(/sooplive\.(?:com|co\.kr)\/([^/?#]+)/);
    if (m3) return m3[1];
    // www.afreecatv.com/{bjId}
    const m4 = url.match(/afreecatv\.com\/([^/?#]+)/);
    if (m4) return m4[1];
    return null;
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
    const bjId = this.extractBjId(url);
    if (!bjId) throw new Error("无法从链接解析出 SOOP 主播ID (bjId)");

    const cookie = cookieStr ?? this.cookie;

    try {
      const info = await getInfo(bjId, {
        cookie,
        username: this.username,
        password: this.password,
      });
      return {
        userId: bjId,
        redId: null,
        name: info.owner || "未知主播",
        avatar: info.avatar,
        roomId: info.bno || null,
        living: info.living,
        title: info.title || "",
      };
    } catch {
      // API 失败时，返回基础信息
      return {
        userId: bjId,
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
  async getRoomInfo(bjId: string): Promise<LiveInfo> {
    const { info, stream } = await getInfoAndStream(bjId, {
      cookie: this.cookie,
      username: this.username,
      password: this.password,
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
   * 默认请求最高画质（OD=原画）
   *
   * @param bjId    主播 ID
   * @param _format 输出格式（SOOP 仅支持 HLS）
   * @param quality 期望画质 (OD/UHD/HD/SD/LD)，默认 OD
   */
  async getStreams(
    bjId: string,
    _format: Array<"flv" | "hls"> = ["hls"],
    quality?: string | RecordQuality,
  ): Promise<
    Array<{
      name: string;
      streams: Array<{ url: string; quality: string; format: "flv" | "hls" }>;
    }>
  > {
    const stream = await getStream({
      bjId,
      quality: quality || "OD",
      cookie: this.cookie,
      username: this.username,
      password: this.password,
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

export { getInfo, getStream, getInfoAndStream, fetchStationStatus };
