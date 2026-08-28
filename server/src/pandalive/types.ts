/**
 * Pandalive 直播 API 类型定义
 * 移植自 StreamCap/StreamGet 的 Pandalive 模块
 */

/** Pandalive 直播流结果 */
export interface PandaliveStreamResult {
  url: string;
  name: string;
  quality: string;
  bitrate: number;
}

/** Pandalive 用户信息 */
export interface PandaliveUserInfo {
  name: string;
  living: boolean;
  userId: string;
  avatar: string;
}

/** member/bj 接口响应 (字段名与 StreamGet 一致) */
export interface PandaliveMemberInfo {
  /** bjInfo 包含主播基本信息 */
  bjInfo?: {
    id?: string;
    nick?: string;
    profileImage?: string;
    userId?: string;
  };
  /** media 存在表示在直播 */
  media?: {
    title?: string;
    isLive?: boolean;
    isPassword?: boolean;
  } | null;
  [key: string]: unknown;
}

/** live/play 接口的 PlayList 中的 hls 项 */
export interface PandaliveHlsItem {
  url: string;
  [key: string]: unknown;
}

/** live/play 接口响应 */
export interface PandalivePlayResult {
  PlayList?: {
    hls?: PandaliveHlsItem[];
  };
  /** 错误信息 (如 needAdult 需要登录Cookie) */
  errorData?: {
    code?: string;
    message?: string;
  };
  message?: string;
  [key: string]: unknown;
}

/** M3U8 解析出的画质变体 */
export interface PandaliveM3u8Variant {
  url: string;
  bandwidth: number;
  resolution?: string;
}

/** Pandalive 画质映射 (码率) */
export const PandaliveQualityMappingBit: Record<string, number> = {
  OD: 99999,
  UHD: 6000,
  HD: 3000,
  SD: 1500,
  LD: 800,
};

/** Pandalive 画质描述 */
export const PandaliveQualityDesc: Record<string, string> = {
  OD: '原画',
  UHD: '超清',
  HD: '高清',
  SD: '标清',
  LD: '流畅',
};
