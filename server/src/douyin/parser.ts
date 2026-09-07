import { getRoomInfo as apiGetRoomInfo, resolveShortURL, parseUser, setProxy } from "./api.js";
import type { StreamInfo } from "./types.js";
import type { LiveInfo } from "../types.js";

/**
 * 画质优先级顺序：origin > real_origin > uhd > hd > sd > ld
 */
const QUALITY_PRIORITY = ["origin", "real_origin", "uhd", "hd", "sd", "ld"];

/**
 * 按画质优先级选择最高画质流。
 * 抖音部分房间的流为 H.265/ByteVC1 编码:ByteVC1 为字节自研编码,
 * FFmpeg 无法解码(录制即失败或录出的 MP4 无法播放),因此尽量跳过,
 * 仅在所有流都是 ByteVC1 时兜底返回。H.265 可解码但部分播放器
 * (如 Telegram)显示马赛克,由上传前兼容转码兜底。
 */
function selectBestStream(streams: StreamInfo[]): StreamInfo | undefined {
  let byteVC1Fallback: StreamInfo | undefined;
  for (const q of QUALITY_PRIORITY) {
    const s = streams.find((x) => x.quality === q);
    if (!s) continue;
    if (s.codec === "bytevc1") {
      if (!byteVC1Fallback) byteVC1Fallback = s;
      continue;
    }
    return s;
  }
  // 回退：第一个可用的流(同样跳过 ByteVC1)
  const first = streams.find((s) => s.flv || s.hls);
  if (first && first.codec !== "bytevc1") return first;
  return byteVC1Fallback ?? first;
}

export class DouyinParser {
  readonly platform = "douyin";
  readonly siteURL = "https://live.douyin.com/";
  static readonly matchPattern = /douyin\.com/;

  private cookie?: string;

  constructor(options?: { cookie?: string; proxy?: string }) {
    this.cookie = options?.cookie;
    if (options?.proxy) {
      setProxy(options.proxy);
    }
  }

  matchURL(url: string): boolean {
    return (
      /https?:\/\/(live|v|www)\.douyin\.com\//.test(url) ||
      DouyinParser.matchPattern.test(url)
    );
  }

  /**
   * 解析 URL，返回 roomId(webRid) 和 userId(sec_uid)
   *
   * 支持的 URL 格式：
   * - live.douyin.com/{webRid}  → roomId, kind='live'
   * - v.douyin.com/xxx          → 需网络请求解析，返回 roomId, kind='live'
   * - www.douyin.com/user/{secUid} → userId, kind='profile'
   */
  async extractUrl(url: string): Promise<{
    roomId: string | null;
    userId: string | null;
    kind: "live" | "profile" | "unknown";
  }> {
    url = url.trim();

    // 短链接：需要网络请求解析得到 webRid
    if (/v\.douyin\.com/.test(url)) {
      try {
        const webRid = await resolveShortURL(url);
        return { roomId: webRid, userId: null, kind: "live" };
      } catch {
        return { roomId: null, userId: null, kind: "unknown" };
      }
    }

    if (!/douyin\.com/.test(url)) {
      throw new Error(`不支持的 URL: ${url}`);
    }

    const urlObj = new URL(url);
    const parts = urlObj.pathname.split("/").filter(Boolean);

    // live.douyin.com/{webRid}
    if (urlObj.hostname === "live.douyin.com") {
      return {
        roomId: parts[0] || null,
        userId: null,
        kind: "live",
      };
    }

    // www.douyin.com/user/{secUid}
    if (parts[0] === "user" && parts[1]) {
      return {
        roomId: null,
        userId: parts[1],
        kind: "profile",
      };
    }

    return { roomId: null, userId: null, kind: "unknown" };
  }

  /**
   * 从任意链接解析主播信息
   *
   * 支持：
   * - live.douyin.com/{webRid}  → 直接获取房间信息
   * - v.douyin.com/xxx          → 解析短链接获取 webRid
   * - www.douyin.com/user/{secUid} → 通过 parseUser 获取 uniqueId(webRid)
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
    const extracted = await this.extractUrl(url);

    let webRid: string | null = extracted.roomId;
    const secUid = extracted.userId;

    // 主页链接：通过 parseUser 获取 uniqueId（即 webRid）
    if (extracted.kind === "profile" && secUid) {
      try {
        const uniqueId = await parseUser(`https://www.douyin.com/user/${secUid}`);
        if (uniqueId) {
          webRid = uniqueId;
        }
      } catch {
        // ignore parse errors
      }
    }

    if (!webRid) {
      throw new Error("无法从链接解析出直播间ID");
    }

    // 获取房间信息
    const info = await apiGetRoomInfo(webRid, {
      auth: cookieStr ?? this.cookie,
    });

    return {
      userId: secUid ?? info.uid ?? webRid,
      redId: null, // 抖音没有 redId
      name: info.owner || "未知主播",
      avatar: info.avatar,
      roomId: info.roomId,
      living: info.living,
      title: info.title || "",
    };
  }

  /**
   * 获取房间信息（返回 red 项目的 LiveInfo 类型）
   */
  async getRoomInfo(roomId: string): Promise<LiveInfo> {
    const info = await apiGetRoomInfo(roomId, { auth: this.cookie });

    // 选择最高画质的流地址
    let flvUrl: string | undefined;
    let m3u8Url: string | undefined;

    if (info.sources.length > 0) {
      const source = info.sources[0];

      // 按画质优先级选择最高画质(跳过不可解码的 ByteVC1 流)
      const bestStream = selectBestStream(source.streams);

      if (bestStream) {
        flvUrl = bestStream.flv;
        m3u8Url = bestStream.hls;
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
   *
   * 从 sources[0].streams 中按画质优先级选择最高画质，
   * 优先选择 origin，然后 real_origin, uhd, hd, sd, ld
   * flv 优先于 hls
   */
  async getStreams(
    roomId: string,
    format: Array<"flv" | "hls"> = ["flv", "hls"],
  ): Promise<
    Array<{
      name: string;
      streams: Array<{ url: string; quality: string; format: "flv" | "hls" }>;
    }>
  > {
    const info = await apiGetRoomInfo(roomId, { auth: this.cookie });
    if (!info.living) return [];
    if (info.sources.length === 0) return [];

    const source = info.sources[0];

    // 按画质优先级选择最高画质(跳过不可解码的 ByteVC1 流)
    const targetStream = selectBestStream(source.streams);
    if (!targetStream) return [];

    // 按格式优先级返回 URL（默认 flv 优先于 hls）
    const streams: Array<{
      url: string;
      quality: string;
      format: "flv" | "hls";
    }> = [];
    for (const fmt of format) {
      const url = targetStream[fmt];
      if (url) {
        streams.push({ url, quality: targetStream.name, format: fmt });
      }
    }

    return streams.length ? [{ name: "自动", streams }] : [];
  }
}

export { resolveShortURL, parseUser, apiGetRoomInfo as getRoomInfo };
