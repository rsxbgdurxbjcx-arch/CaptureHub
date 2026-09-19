/**
 * 斗鱼直播流解析逻辑 (组合 api 层)
 * 移植自 biliup crates/biliup/src/downloader/live/douyu.rs 的 check_stream 流程
 */
import { fetchRoomInfo, getWebStreamUrl } from './api.js';

export interface DouyuGetInfoResult {
  living: boolean;
  owner: string;
  avatar: string;
  title: string;
  roomId: string;
}

export interface DouyuStreamResult {
  url: string;
  quality: string;
  format: 'flv';
}

/** 获取直播间基础信息 (在播判定: betard show_status=1 且 videoLoop=0) */
export async function getInfo(roomId: string): Promise<DouyuGetInfoResult> {
  const room = await fetchRoomInfo(roomId);
  return {
    living: !!room,
    owner: room ? String(room.nickname || '') : '',
    avatar: room ? String(room.avatar || '') : '',
    title: room ? String(room.room_name || '') : '',
    roomId,
  };
}

/** 获取拉流地址 (原画 rate=0, 与 biliup 一致) */
export async function getStream(roomId: string): Promise<DouyuStreamResult> {
  const url = await getWebStreamUrl(roomId);
  return { url, quality: '原画', format: 'flv' };
}

/** 一次性获取直播信息与流地址 (在播才请求流地址) */
export async function getInfoAndStream(roomId: string): Promise<{
  info: DouyuGetInfoResult;
  stream: DouyuStreamResult | null;
}> {
  const info = await getInfo(roomId);
  let stream: DouyuStreamResult | null = null;
  if (info.living) {
    try {
      stream = await getStream(roomId);
    } catch (e) {
      console.warn(
        `[douyu] 流地址获取失败: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return { info, stream };
}
