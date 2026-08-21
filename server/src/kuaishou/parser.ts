/**
 * 快手 URL 解析器
 * 移植自 streamget 的快手解析逻辑
 * 适配 red 项目的 LiveInfo / Streamer 接口
 */
import { getInfo, getStream, getInfoAndStream } from "./stream.js";
import { getUserInfo } from "./api.js";
import type { LiveInfo } from "../types.js";

export class KuaishouParser {
  readonly platform = "kuaishou";
  readonly siteURL = "https://live.kuaishou.com/";
  static readonly matchPattern = /kuaishou\.com|live\.kuaishou/;

  private cookie?: string;

  constructor(options?: { cookie?: string }) {
    this.cookie = options?.cookie;
  }

  matchURL(url: string): boolean {
    return (
      /https?:\/\/(?:.*?\.)?kuaishou\.com\//.test(url) ||
      /https?:\/\/live\.kuaishou\.com\//.test(url) ||
      KuaishouParser.matchPattern.test(url)
    );
  }

  /**
   * 从 URL 提取快手用户 ID (eid)
   * 支持的 URL 格式：
   * - https://live.kuaishou.com/u/{eid}     → 用户主页/直播页
   * - https://live.kuaishou.com/{eid}       → 直播间
   * - https://www.kuaishou.com/profile/{eid} → 用户主页
   */
  extractEid(url: string): string | null {
    url = url.trim();
    // live.kuaishou.com/u/{eid}
    const m = url.match(/live\.kuaishou\.com\/u\/([\w]+)/);
    if (m) return m[1];
    // live.kuaishou.com/{eid} (非 u/ 路径，排除已知路径)
    const m2 = url.match(/live\.kuaishou\.com\/([\w]+)/);
    if (m2 && m2[1] !== "u" && !["u", "profile"].includes(m2[1])) return m2[1];
    // www.kuaishou.com/profile/{eid}
    const m3 = url.match(/kuaishou\.com\/profile\/([\w]+)/);
    if (m3) return m3[1];
    return null;
  }

  /**
   * 从链接解析主播信息
   * 支持 live.kuaishou.com/u/{eid} 和 live.kuaishou.com/{eid}
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
    const eid = this.extractEid(url);
    if (!eid) throw new Error("无法从链接解析出快手用户ID");

    const cookie = cookieStr ?? this.cookie;

    // 优先尝试通过 API 获取用户信息
    let name = "";
    let living = false;
    let userId = eid;
    let avatar = "";

    try {
      const userInfo = await getUserInfo(eid, cookie);
      name = userInfo.name;
      living = userInfo.living;
      userId = userInfo.userId;
      avatar = userInfo.avatar;
    } catch {
      // API 失败时，尝试通过页面解析
    }

    // 通过页面解析获取完整信息
    try {
      const info = await getInfo(eid, { cookie });
      if (info.owner) name = info.owner;
      if (info.avatar) avatar = info.avatar;
      if (info.userId) userId = info.userId;
      living = info.living || living;

      return {
        userId,
        redId: null,
        name: name || "未知主播",
        avatar,
        roomId: info.roomId !== eid ? info.roomId : null,
        living,
        title: info.title || "",
      };
    } catch {
      // 页面解析也失败，返回基础信息
      return {
        userId,
        redId: null,
        name: name || "未知主播",
        avatar,
        roomId: null,
        living,
        title: "",
      };
    }
  }

  /** 获取房间信息（返回 red 项目的 LiveInfo 类型）
   *  使用 getInfoAndStream 只请求一次 HTML 页面，避免重复请求导致限流
   */
  async getRoomInfo(eid: string): Promise<LiveInfo> {
    const { info, stream } = await getInfoAndStream(eid, { cookie: this.cookie });

    let flvUrl: string | undefined;
    let m3u8Url: string | undefined;

    if (stream?.url) {
      if (stream.url.includes(".m3u8")) {
        m3u8Url = stream.url;
      } else {
        flvUrl = stream.url;
      }
    }

    return {
      living: info.living,
      roomId: info.roomId,
      title: info.title,
      owner: info.owner,
      avatar: info.avatar,
      cover: info.cover,
      flvUrl,
      m3u8Url,
    };
  }

  /**
   * 获取流地址
   * 默认请求最高画质（OD=原画），自动降级
   */
  async getStreams(
    eid: string,
    _format: Array<"flv" | "hls"> = ["flv", "hls"],
  ): Promise<
    Array<{
      name: string;
      streams: Array<{ url: string; quality: string; format: "flv" | "hls" }>;
    }>
  > {
    const stream = await getStream({
      eid,
      cookie: this.cookie,
    });

    const isHls = stream.url.includes(".m3u8") || stream.url.includes("/ts/");
    const fmt: "flv" | "hls" = isHls ? "hls" : "flv";

    return [
      {
        name: "自动",
        streams: [{ url: stream.url, quality: stream.name, format: fmt }],
      },
    ];
  }
}

export { getUserInfo, getInfo, getStream, getInfoAndStream };
