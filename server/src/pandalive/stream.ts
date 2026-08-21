/**
 * Pandalive 直播流解析逻辑
 * 移植自 StreamCap/StreamGet 的 Pandalive 模块
 *
 * 关键实现细节：
 * 1. 通过 member/bj 接口检测直播状态 (media 字段存在表示在播)
 * 2. 调用 live/play 接口获取 PlayList.hls[0].url
 * 3. 解析 M3U8 获取多画质变体 (按 BANDWIDTH 排序)
 * 4. 根据期望画质选择对应的流地址
 */
import {
  fetchMemberInfo,
  fetchStreamUrl,
  fetchM3u8Content,
} from "./api.js";
import {
  PandaliveQualityMappingBit,
  PandaliveQualityDesc,
} from "./types.js";
import type { PandaliveM3u8Variant, PandaliveMemberInfo } from "./types.js";

export interface PandaliveGetInfoResult {
  living: boolean;
  owner: string;
  title: string;
  roomId: string;
  avatar: string;
  cover: string;
  userId: string;
}

export interface PandaliveStreamResult {
  url: string;
  name: string;
  quality: string;
  bitrate: number;
}

/**
 * 解析 M3U8 主播放列表，提取所有画质变体
 * 按 BANDWIDTH 从高到低排序
 */
export function parseM3u8Variants(
  m3u8Content: string,
  baseUrl: string,
): PandaliveM3u8Variant[] {
  const variants: PandaliveM3u8Variant[] = [];
  const lines = m3u8Content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.startsWith("#EXT-X-STREAM-INF:")) continue;

    const attrStr = line.slice("#EXT-X-STREAM-INF:".length);
    const bandwidthMatch = attrStr.match(/BANDWIDTH=(\d+)/i);
    const resolutionMatch = attrStr.match(/RESOLUTION=([0-9x]+)/i);
    const bandwidth = bandwidthMatch ? Number(bandwidthMatch[1]) : 0;

    // 下一行非空内容即为流地址
    const nextLine = lines[i + 1]?.trim();
    if (!nextLine || nextLine.startsWith("#")) continue;

    const streamUrl = resolveUrl(nextLine, baseUrl);
    variants.push({
      url: streamUrl,
      bandwidth,
      resolution: resolutionMatch ? resolutionMatch[1] : undefined,
    });
  }

  // 按 BANDWIDTH 从高到低排序
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

/** 将相对 URL 解析为绝对 URL */
function resolveUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/**
 * 根据期望画质选择 M3U8 变体
 * - OD(原画): 选 BANDWIDTH 最高的
 * - 其他: 选不超过目标码率的最大值，找不到则选最高
 */
export function selectQuality(
  variants: PandaliveM3u8Variant[],
  desiredQuality: string,
): PandaliveM3u8Variant | null {
  if (variants.length === 0) return null;
  if (desiredQuality === "OD") return variants[0];

  const desiredBitrate = PandaliveQualityMappingBit[desiredQuality] || 99999;
  // 不超过目标码率的最大值
  const matched = variants.find((v) => v.bandwidth <= desiredBitrate * 1000);
  return matched || variants[0];
}

/**
 * 获取 Pandalive 直播间完整信息
 *
 * 流程:
 * 1. 调用 member/bj 获取主播信息和直播状态
 * 2. 直播状态以 media 字段是否存在为准
 */
export async function getInfo(
  userId: string,
  opts: { cookie?: string } = {},
): Promise<PandaliveGetInfoResult> {
  const member: PandaliveMemberInfo = await fetchMemberInfo(
    userId,
    opts.cookie,
  );

  const media = member.media;
  const living = !!media && (media.isLive !== false);
  // 字段名与 StreamGet 一致: bjInfo.id / bjInfo.nick
  const owner = String(member.bjInfo?.nick || member.bjInfo?.id || userId);
  const avatar = String(member.bjInfo?.profileImage || "");
  const title = String(media?.title || "");

  return {
    living,
    owner,
    title,
    roomId: userId,
    avatar,
    cover: "",
    userId,
  };
}

/**
 * 获取流地址（对外主入口）
 * 默认请求最高画质（OD=原画），画质不匹配时自动降级
 *
 * 流程:
 * 1. 调用 live/play 获取 PlayList.hls[0].url
 * 2. 解析 M3U8 获取多画质变体
 * 3. 根据期望画质选择对应流地址
 */
export async function getStream(opts: {
  userId: string;
  quality?: string;
  password?: string;
  cookie?: string;
}): Promise<PandaliveStreamResult> {
  const desiredQuality = opts.quality || "OD";

  // 获取 HLS 地址
  const hlsUrl = await fetchStreamUrl(
    opts.userId,
    opts.password,
    opts.cookie,
  );

  // 获取 M3U8 内容并解析画质变体
  let m3u8Content = "";
  try {
    m3u8Content = await fetchM3u8Content(hlsUrl, opts.cookie);
  } catch {
    // 解析失败时直接使用原始 HLS 地址
    const qualityDesc = PandaliveQualityDesc[desiredQuality] || desiredQuality;
    return {
      url: hlsUrl,
      name: qualityDesc,
      quality: desiredQuality,
      bitrate: 0,
    };
  }

  const variants = parseM3u8Variants(m3u8Content, hlsUrl);

  // 如果只有一个变体或无变体，直接返回原始地址
  if (variants.length === 0) {
    const qualityDesc = PandaliveQualityDesc[desiredQuality] || desiredQuality;
    return {
      url: hlsUrl,
      name: qualityDesc,
      quality: desiredQuality,
      bitrate: 0,
    };
  }

  console.log(
    `[pandalive] 可用画质 ${variants.length} 条:`,
    variants.map((v) => ({
      bandwidth: v.bandwidth,
      resolution: v.resolution || "?",
    })),
  );

  const selected = selectQuality(variants, desiredQuality);
  const qualityDesc = PandaliveQualityDesc[desiredQuality] || desiredQuality;
  const resDesc = selected?.resolution ? ` ${selected.resolution}` : "";

  return {
    url: selected!.url,
    name: `${qualityDesc}${resDesc}`,
    quality: desiredQuality,
    bitrate: selected!.bandwidth,
  };
}

/**
 * 一次性获取直播信息和流地址
 */
export async function getInfoAndStream(
  userId: string,
  opts: { cookie?: string; quality?: string; password?: string } = {},
): Promise<{
  info: PandaliveGetInfoResult;
  stream: PandaliveStreamResult | null;
}> {
  const desiredQuality = opts.quality || "OD";
  const info = await getInfo(userId, { cookie: opts.cookie });

  let stream: PandaliveStreamResult | null = null;
  if (info.living) {
    try {
      stream = await getStream({
        userId,
        quality: desiredQuality,
        password: opts.password,
        cookie: opts.cookie,
      });
    } catch (e) {
      console.warn(
        `[pandalive] 流地址获取失败:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { info, stream };
}

/**
 * 获取 Pandalive 用户直播状态
 */
export async function getUserLiveStatus(
  userId: string,
  cookie?: string,
): Promise<{ name: string; living: boolean; userId: string }> {
  const info = await getInfo(userId, { cookie });
  return {
    name: info.owner,
    living: info.living,
    userId: info.userId,
  };
}
