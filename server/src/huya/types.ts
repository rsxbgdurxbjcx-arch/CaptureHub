/**
 * 虎牙直播类型定义
 * 移植自 biliup crates/biliup/src/downloader/live/huya.rs
 */

/** 码率档位信息 (vMultiStreamInfo 元素) */
export interface HuyaBitrateInfo {
  /** 码率 (kbps); 缺失或 0 视为原画码率 */
  iBitRate?: number;
  sDisplayName?: string;
}

/** 单条流的 CDN 信息 (gameStreamInfoList 元素) */
export interface HuyaStreamInfo {
  sStreamName?: string;
  sCdnType?: string;
  sFlvUrl?: string;
  sFlvUrlSuffix?: string;
  sFlvAntiCode?: string;
  iWebPriorityRate?: number;
  lPresenterUid?: number | string;
  [key: string]: unknown;
}

/** 房间直播数据 (gameLiveInfo 摘要) */
export interface HuyaRoomProfile {
  title: string;
  cover: string;
  maxBitrate: number;
  bitrateInfo: HuyaBitrateInfo[];
  streamInfo: HuyaStreamInfo[];
  /** 主播昵称 (TT_ROOM_DATA, 可能为空) */
  owner: string;
  /** 主播头像 (TT_ROOM_DATA, 可能为空) */
  avatar: string;
}
