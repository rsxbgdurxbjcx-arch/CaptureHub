/**
 * 快手直播 API 类型定义
 * 基于实际 API 响应和 streamget 的快手模块
 */

/** 快手用户信息 API 响应（实际字段名） */
export interface KsUserInfoResp {
  data: {
    result: number;
    userInfo: {
      id: string;
      name: string;
      living: boolean;
      avatar: string;
      originUserId?: number;
      description?: string;
    };
  };
}

/** 快手直播流 representation（单条流地址） */
export interface KsRepresentation {
  url: string;
  bitrate: number;
  qualityType?: string;
  name?: string;
  shortName?: string;
  /** 视频宽度（像素） */
  width?: number;
  /** 视频高度（像素） */
  height?: number;
  /** 帧率 */
  frameRate?: number;
  /** 编码格式（由 playUrls key 推断，如 h264/hevc） */
  codec?: string;
}

/** 快手直播流 playUrls 结构 */
export interface KsPlayUrls {
  h264?: {
    adaptationSet?: {
      representation?: KsRepresentation[];
    };
  };
  hevc?: {
    adaptationSet?: {
      representation?: KsRepresentation[];
    };
  };
  [key: string]: unknown;
}

/** 快手直播流 liveStream 结构（实际字段名） */
export interface KsLiveStream {
  playUrls?: KsPlayUrls;
  poster?: string;
  id?: string;
  url?: string;
  hlsPlayUrl?: string;
  type?: string;
  liveGuess?: boolean;
  privateLive?: boolean;
}

/** 快手页面 __INITIAL_STATE__ 中提取的 liveStream 数据 */
export interface KsPlayList {
  author?: {
    id?: string;
    name?: string;
    avatar?: string;
    description?: string;
    living?: boolean;
  };
  liveStream?: KsLiveStream;
  errorType?: {
    title?: string;
    content?: string;
  };
}

/** 快手画质映射（码率）— 与 streamget quality_mapping_bit 一致 */
export const QualityMappingBit: Record<string, number> = {
  OD: 99999,
  BD: 4000,
  UHD: 2000,
  HD: 1000,
  SD: 800,
  LD: 600,
};

/** 快手画质选项（从高到低） */
export const KsQualities = ['OD', 'BD', 'UHD', 'HD', 'SD', 'LD'] as const;

/** 快手画质描述 */
export const KsQualityDesc: Record<string, string> = {
  OD: '原画',
  BD: '蓝光',
  UHD: '超清',
  HD: '高清',
  SD: '标清',
  LD: '流畅',
};
