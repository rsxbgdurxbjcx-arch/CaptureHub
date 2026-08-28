/**
 * Bilibili URL 解析器
 * 移植自 biliLive-tools 的 BilibiliRecorder + StreamGet 逻辑
 * 适配 red 项目的 LiveInfo / Streamer 接口
 */
import { getInfo, getStream } from "./stream.js";
import { getRoomInit } from "./api.js";
import type { LiveInfo } from "../types.js";
import { BiliQualities, QualityDesc } from "./types.js";

export class BilibiliParser {
  readonly platform = "bilibili";
  readonly siteURL = "https://live.bilibili.com/";
  static readonly matchPattern = /bilibili\.com|live\.bilibili/;

  private cookie?: string;

  constructor(options?: { cookie?: string }) {
    this.cookie = options?.cookie;
  }

  matchURL(url: string): boolean {
    return (
      /https?:\/\/(?:.*?\.)?bilibili\.com\//.test(url) ||
      /https?:\/\/live\.bilibili\.com\//.test(url) ||
      BilibiliParser.matchPattern.test(url)
    );
  }

  /** 从 URL 提取房间号（支持短号） */
  extractRoomId(url: string): string | null {
    url = url.trim();
    // live.bilibili.com/{roomId}
    const m = url.match(/live\.bilibili\.com\/(\d+)/);
    if (m) return m[1];
    // live.bilibili.com/h5/{roomId}
    const m2 = url.match(/live\.bilibili\.com\/h5\/(\d+)/);
    if (m2) return m2[1];
    // space.bilibili.com/{uid}/live
    const m3 = url.match(/space\.bilibili\.com\/(\d+)/);
    if (m3) return m3[1];
    return null;
  }

  /**
   * 从链接解析主播信息
   * 支持 live.bilibili.com/{roomId} 和 space.bilibili.com/{uid}
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
    const rawId = this.extractRoomId(url);
    if (!rawId) throw new Error("无法从链接解析出B站房间号");

    // 通过 room_init 将短号转为真实 room_id
    const roomInit = await getRoomInit(Number(rawId));
    const realRoomId = String(roomInit.room_id);
    const uid = String(roomInit.uid);

    const info = await getInfo(realRoomId, { cookie: cookieStr ?? this.cookie });

    return {
      userId: uid,
      redId: null, // B站没有 redId
      name: info.owner || "未知主播",
      avatar: info.avatar,
      roomId: realRoomId,
      living: info.living,
      title: info.title || "",
    };
  }

  /** 获取房间信息（返回 red 项目的 LiveInfo 类型） */
  async getRoomInfo(roomId: string): Promise<LiveInfo> {
    const info = await getInfo(roomId, { cookie: this.cookie });

    let flvUrl: string | undefined;
    let m3u8Url: string | undefined;

    if (info.living && info.canRecord) {
      try {
        const stream = await getStream({
          channelId: roomId,
          cookie: this.cookie,
        });
        flvUrl = stream.url;
      } catch {
        // 取流失败不影响状态检测
      }
    }

    return {
      living: info.living,
      roomId: String(info.roomId),
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
   * 默认请求最高画质，画质不匹配时自动降级
   */
  async getStreams(
    roomId: string,
    _format: Array<"flv" | "hls"> = ["flv", "hls"],
  ): Promise<
    Array<{
      name: string;
      streams: Array<{ url: string; quality: string; format: "flv" | "hls" }>;
    }>
  > {
    const stream = await getStream({
      channelId: roomId,
      cookie: this.cookie,
    });

    const qualityDesc = QualityDesc[stream.current_qn] || `qn=${stream.current_qn}`;
    const isHls = stream.url.includes(".m3u8") || stream.url.includes("/ts/");
    const fmt: "flv" | "hls" = isHls ? "hls" : "flv";

    return [
      {
        name: "自动",
        streams: [{ url: stream.url, quality: qualityDesc, format: fmt }],
      },
    ];
  }
}
