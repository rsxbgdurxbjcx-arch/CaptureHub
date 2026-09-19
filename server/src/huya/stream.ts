/**
 * 虎牙直播流解析逻辑
 * 移植自 biliup crates/biliup/src/downloader/live/huya.rs 的 check_stream 流程
 *
 * 默认行为与 biliup 一致: FLV 协议、首个 CDN (按 iWebPriorityRate 降序)、
 * codec=264、max_ratio=0 (原画)。
 */
import { buildAnticode, getCdnTokenInfoEx, getRoomProfile, jsonStr } from './api.js';
import type { HuyaBitrateInfo, HuyaRoomProfile, HuyaStreamInfo } from './types.js';

const HUYA_CODEC = '264';

/**
 * 画质 → max_ratio 近似映射 (biliup 的 max_ratio 为码率上限, 单位 kbps):
 * 从 vMultiStreamInfo 选择不超过上限的最大码率档位; OD=0 表示不限制 (原画)。
 */
export const HUYA_QUALITY_MAX_RATIO: Record<string, number> = {
  OD: 0,
  UHD: 10000,
  HD: 4000,
  SD: 2000,
  LD: 1000,
};

export interface HuyaGetInfoResult {
  living: boolean;
  title: string;
  owner: string;
  avatar: string;
  cover: string;
  roomId: string;
}

export interface HuyaStreamResult {
  url: string;
  quality: string;
}

export interface HuyaStreamUrl {
  cdn: string;
  priority: number;
  url: string;
}

/** 标题前三/后三字含「回放/重播」视为录像, 不计入直播 */
export function isReplayTitle(title: string): boolean {
  const chars = [...title];
  const head = chars.slice(0, 3).join('');
  const tail = chars.slice(Math.max(0, chars.length - 3)).join('');
  return ['回放', '重播'].some((key) => head.includes(key) || tail.includes(key));
}

/**
 * 构建各 CDN 的拉流地址:
 * - 同一房间所有 CDN 共用同一 stream_name, 防盗链参数只计算一次
 * - 防盗链优先用 WUP getCdnTokenInfoEx 的新 token 重建,
 *   失败时回退页面自带的 sFlvAntiCode
 * - 按 iWebPriorityRate 降序排序, 过滤 HY/HUYA/HYZJ 内部 CDN
 */
export async function buildStreamUrls(
  streamsInfo: HuyaStreamInfo[],
): Promise<HuyaStreamUrl[]> {
  const streams: HuyaStreamUrl[] = [];
  let cachedAnticode: string | null = null;

  for (const stream of streamsInfo) {
    const priorityRaw = Number(stream.iWebPriorityRate);
    const priority = Number.isFinite(priorityRaw) ? Math.trunc(priorityRaw) : 0;
    if (priority < 0) continue;

    const streamName = jsonStr(stream, 'sStreamName');
    const cdn = jsonStr(stream, 'sCdnType');
    const suffix = jsonStr(stream, 'sFlvUrlSuffix');
    const baseUrl = jsonStr(stream, 'sFlvUrl').replace('http://', 'https://');
    const presenterUidRaw = Number(stream.lPresenterUid);
    const presenterUid = Number.isFinite(presenterUidRaw) ? presenterUidRaw : 0;

    if (cachedAnticode === null) {
      let anticode: string;
      try {
        const token = await getCdnTokenInfoEx(streamName);
        anticode = buildAnticode(streamName, token, presenterUid);
      } catch (e) {
        console.warn(
          `[huya] getCdnTokenInfoEx 失败, 回退页面防盗链参数: ${e instanceof Error ? e.message : e}`,
        );
        anticode = buildAnticode(streamName, jsonStr(stream, 'sFlvAntiCode'), presenterUid);
      }
      cachedAnticode = `${anticode}&codec=${HUYA_CODEC}`;
    }

    streams.push({
      cdn,
      priority,
      url: `${baseUrl}/${streamName}.${suffix}?${cachedAnticode}`,
    });
  }

  streams.sort((a, b) => b.priority - a.priority);
  return streams.filter((s) => !['HY', 'HUYA', 'HYZJ'].includes(s.cdn));
}

/**
 * 按码率上限选择档位并追加 ratio 参数 (maxRatio=0 表示原画不限)
 */
export function addRatio(
  url: string,
  bitrateInfo: HuyaBitrateInfo[],
  maxRatio: number,
): string {
  if (maxRatio === 0 || url.includes('&ratio')) return url;

  let selected: number | null = null;
  for (const info of bitrateInfo) {
    const raw = Number(info.iBitRate);
    // iBitRate 缺失或为 0 视为原画码率 (与 biliup 语义一致)
    const bitrate = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : maxRatio;
    if (bitrate <= maxRatio) {
      selected = selected === null ? bitrate : Math.max(selected, bitrate);
    }
  }
  return selected !== null && selected > 0 ? `${url}&ratio=${selected}` : url;
}

/** 获取直播间信息 (在播判定: state=ON 且有码率信息; 回放标题视为未开播) */
export async function getInfo(roomId: string): Promise<HuyaGetInfoResult> {
  const profile = await getRoomProfile(roomId);
  const living = !!profile && !isReplayTitle(profile.title);
  return {
    living,
    title: profile?.title ?? '',
    owner: profile?.owner ?? '',
    avatar: profile?.avatar ?? '',
    cover: profile?.cover ?? '',
    roomId,
  };
}

/** 选择 CDN 并应用码率上限 (默认第一个, 即优先级最高的 CDN) */
async function pickStreamUrl(
  profile: HuyaRoomProfile,
  maxRatio: number,
): Promise<string> {
  const urls = await buildStreamUrls(profile.streamInfo);
  if (urls.length === 0) throw new Error('虎牙可用 CDN 为空');
  return addRatio(urls[0].url, profile.bitrateInfo, maxRatio);
}

/** 获取拉流地址 (maxRatio: 码率上限 kbps, 0=原画) */
export async function getStream(roomId: string, maxRatio = 0): Promise<HuyaStreamResult> {
  const profile = await getRoomProfile(roomId);
  if (!profile || isReplayTitle(profile.title)) {
    throw new Error('虎牙直播间未开播');
  }
  return { url: await pickStreamUrl(profile, maxRatio), quality: 'OD' };
}

/**
 * 一次性获取直播信息与流地址 (只抓一次房间页; 在播才构建流地址)
 */
export async function getInfoAndStream(
  roomId: string,
  maxRatio = 0,
): Promise<{ info: HuyaGetInfoResult; stream: HuyaStreamResult | null }> {
  const profile = await getRoomProfile(roomId);
  const living = !!profile && !isReplayTitle(profile.title);
  const info: HuyaGetInfoResult = {
    living,
    title: profile?.title ?? '',
    owner: profile?.owner ?? '',
    avatar: profile?.avatar ?? '',
    cover: profile?.cover ?? '',
    roomId,
  };

  let stream: HuyaStreamResult | null = null;
  if (living && profile) {
    try {
      stream = { url: await pickStreamUrl(profile, maxRatio), quality: 'OD' };
    } catch (e) {
      console.warn(`[huya] 流地址获取失败: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { info, stream };
}
