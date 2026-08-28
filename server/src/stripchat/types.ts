/**
 * Stripchat 直播 API 类型定义
 * 移植自 StripchatRecorder 的 backend/src/streaming/stripchat.rs
 * https://github.com/ChanTrail/StripchatRecorder
 */

/** Stripchat cam API 响应 (json.user.user / json.cam 关键字段) */
export interface StripchatCamResponse {
  user?: {
    user?: {
      /** 模型 ID,用于拼接 CDN master 播放列表 */
      id?: number;
      isLive?: boolean;
      viewersCount?: number;
      /** public / private / groupShow / virtualPrivate / p2p / idle / off */
      status?: string;
      /** 缩略图时间戳 (数字或字符串) */
      snapshotTimestamp?: number | string;
      previewUrl?: string;
      username?: string;
    };
  };
  cam?: {
    streamName?: string;
  };
  [key: string]: unknown;
}

/** master m3u8 解析出的画质变体 */
export interface StripchatVariant {
  url: string;
  bandwidth: number;
  resolution?: string;
}

/** Mouflon PSCH 参数对 (scheme=psch, key=pkey) */
export interface StripchatMouflonPair {
  psch: string;
  pkey: string;
}

/** Stripchat 画质映射 (码率阈值 kbps) */
export const StripchatQualityMappingBit: Record<string, number> = {
  OD: 99999,
  UHD: 6000,
  HD: 3000,
  SD: 1500,
  LD: 800,
};

/** Stripchat 画质描述 */
export const StripchatQualityDesc: Record<string, string> = {
  OD: '原画',
  UHD: '超清',
  HD: '高清',
  SD: '标清',
  LD: '流畅',
};
