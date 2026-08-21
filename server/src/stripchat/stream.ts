/**
 * Stripchat 直播流解析逻辑
 * 移植自 StripchatRecorder 的 backend/src/streaming/stripchat.rs
 *
 * 关键实现细节:
 * 1. cam API 检测直播状态 (isLive + status, 仅 public 状态可录制)
 * 2. master 播放列表多 CDN 竞速获取 ({model_id}_auto.m3u8)
 * 3. 解析最高画质变体 + Mouflon PSCH 参数
 * 4. 变体 URL 追加 psch/pkey → 最终 HLS 地址
 */
import {
  fetchCamInfo,
  fetchGroupShowType,
  fetchMasterPlaylist,
  parseMasterPlaylist,
  selectQuality,
  buildStreamUrl,
} from './api.js';
import { StripchatQualityDesc } from './types.js';

export interface StripchatGetInfoResult {
  living: boolean;
  owner: string;
  title: string;
  roomId: string;
  avatar: string;
  cover: string;
  userId: string;
  modelId: number | null;
  isRecordable: boolean;
}

export interface StripchatStreamResult {
  url: string;
  name: string;
  quality: string;
  bitrate: number;
}

export interface StripchatOptions {
  cookie?: string;
  mouflonKeys?: Record<string, string>;
}

/** 将 Stripchat 状态码转换为中文描述 */
function statusText(status: string, groupShowType: string | null): string {
  switch (status) {
    case 'public':
      return '公开秀';
    case 'private':
      return '私密秀';
    case 'groupShow':
      return groupShowType === 'ticket'
        ? '票务秀'
        : groupShowType === 'perMinute'
          ? '计时秀'
          : '群组秀';
    case 'virtualPrivate':
      return '虚拟私密';
    case 'p2p':
      return 'P2P';
    case 'idle':
      return '等待';
    case 'off':
      return '离线';
    default:
      return status;
  }
}

/**
 * 获取 Stripchat 直播间完整信息
 * 流程 (与 StripchatRecorder get_stream_info 一致):
 * 1. cam API 获取 isLive / status / viewers / thumbnail / modelId
 * 2. status == groupShow 时查询群组秀类型
 */
export async function getInfo(
  username: string,
  opts: StripchatOptions = {},
): Promise<StripchatGetInfoResult> {
  const cam = await fetchCamInfo(username, opts.cookie);

  const user = cam.user?.user ?? {};
  const isLive = user.isLive === true;
  const viewers = Number(user.viewersCount ?? 0) || 0;
  const status = String(user.status ?? 'off');
  const modelId = typeof user.id === 'number' ? user.id : null;

  const groupShowType =
    status === 'groupShow' ? await fetchGroupShowType(username, opts.cookie) : null;
  const statusDesc = statusText(status, groupShowType);

  // 缩略图 (与 StripchatRecorder 一致)
  let thumbnailUrl: string | null = null;
  const previewUrl = typeof user.previewUrl === 'string' ? user.previewUrl : null;
  if (isLive) {
    const snapshotTsRaw = user.snapshotTimestamp;
    const snapshotTs =
      typeof snapshotTsRaw === 'number'
        ? snapshotTsRaw
        : typeof snapshotTsRaw === 'string'
          ? Number(snapshotTsRaw) || 0
          : 0;
    const streamName = String(cam.cam?.streamName ?? '');
    if (snapshotTs > 0 && streamName) {
      thumbnailUrl = `https://img.doppiocdn.net/thumbs/${snapshotTs}/${streamName}`;
    } else {
      thumbnailUrl = previewUrl;
    }
  } else {
    thumbnailUrl = previewUrl;
  }

  const isRecordable = isLive && status === 'public';

  return {
    living: isLive,
    owner: username,
    title: statusDesc,
    roomId: username,
    avatar: thumbnailUrl ?? '',
    cover: '',
    userId: username,
    modelId,
    isRecordable,
  };
}

/**
 * 获取流地址 (对外主入口)
 * 默认请求最高画质 (OD=原画), 画质不匹配时自动降级
 *
 * 流程:
 * 1. 获取 modelId (cam API)
 * 2. master 播放列表多 CDN 竞速
 * 3. 解析变体 + Mouflon 参数, 按画质选择
 * 4. 变体 URL 追加 psch/pkey → 最终 HLS 地址
 */
export async function getStream(opts: {
  username: string;
  quality?: string;
  modelId?: number | null;
  cookie?: string;
  mouflonKeys?: Record<string, string>;
}): Promise<StripchatStreamResult> {
  const desiredQuality = opts.quality || 'OD';
  const username = opts.username;

  let modelId = opts.modelId ?? null;
  if (modelId === null) {
    const cam = await fetchCamInfo(username, opts.cookie);
    const id = cam.user?.user?.id;
    if (typeof id !== 'number') {
      throw new Error('Stripchat 无法获取模型 ID (modelId)');
    }
    modelId = id;
  }

  const { text, baseUrl } = await fetchMasterPlaylist(modelId, opts.cookie);
  const { variants, mouflonPairs } = parseMasterPlaylist(text);

  if (variants.length === 0) {
    throw new Error(`Stripchat 主播 ${username} 未开播或无法解析播放列表`);
  }

  const selected = selectQuality(variants, desiredQuality);
  if (!selected) {
    throw new Error('Stripchat 未解析到可用流');
  }

  const finalUrl = buildStreamUrl(selected.url, baseUrl, mouflonPairs, opts.mouflonKeys);
  const qualityDesc = StripchatQualityDesc[desiredQuality] || desiredQuality;
  const resDesc = selected.resolution ? ` ${selected.resolution}` : '';

  return {
    url: finalUrl,
    name: `${qualityDesc}${resDesc}`,
    quality: desiredQuality,
    bitrate: selected.bandwidth,
  };
}

/**
 * 一次性获取直播信息和流地址
 */
export async function getInfoAndStream(
  username: string,
  opts: { cookie?: string; quality?: string; mouflonKeys?: Record<string, string> } = {},
): Promise<{ info: StripchatGetInfoResult; stream: StripchatStreamResult | null }> {
  const desiredQuality = opts.quality || 'OD';
  const info = await getInfo(username, { cookie: opts.cookie });

  let stream: StripchatStreamResult | null = null;
  if (info.living && info.isRecordable) {
    try {
      stream = await getStream({
        username,
        quality: desiredQuality,
        modelId: info.modelId,
        cookie: opts.cookie,
        mouflonKeys: opts.mouflonKeys,
      });
    } catch (e) {
      console.warn(
        `[stripchat] 流地址获取失败:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { info, stream };
}

/**
 * 获取 Stripchat 用户直播状态
 */
export async function getUserLiveStatus(
  username: string,
  cookie?: string,
): Promise<{ name: string; living: boolean; userId: string }> {
  const info = await getInfo(username, { cookie });
  return {
    name: info.owner,
    living: info.living,
    userId: info.userId,
  };
}
