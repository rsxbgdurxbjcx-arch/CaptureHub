/**
 * SOOP (formerly AfreecaTV) 直播 API 类型定义
 * 完全移植自 streamget 的 SOOP 模块
 * https://github.com/ihmily/streamget/blob/main/streamget/platforms/soop/live_stream.py
 */

/** SOOP 直播流结果 */
export interface SoopStreamResult {
  url: string;
  name: string;
  quality: string;
  bitrate: number;
}

/** SOOP 用户信息 */
export interface SoopUserInfo {
  name: string;
  living: boolean;
  userId: string;
  avatar: string;
}

/** get_station_status.php 响应 — DATA 嵌套结构 */
export interface SoopStationData {
  station_no?: string;
  user_id?: string;
  user_nick?: string;
  station_name?: string;
  station_title?: string;
  broad_start?: string;
  total_broad_time?: string;
  grade?: string;
  fan_cnt?: string;
  total_visit_cnt?: string;
  total_ok_cnt?: string;
  total_view_cnt?: string;
  today_visit_cnt?: string;
  today_ok_cnt?: string;
  today_fav_cnt?: string;
  total_sub_cnt?: number;
  [key: string]: unknown;
}

export interface SoopStationStatus {
  RESULT?: number;
  DATA?: SoopStationData;
  [key: string]: unknown;
}

/** player_live_api.php 响应 — CHANNEL 嵌套结构 */
export interface SoopChannelInfo {
  /** 状态码: 0/1 = 正常, 其他需要登录 */
  RESULT?: number;
  /** 直播编号 */
  BNO?: string;
  /** 直播标题 */
  TITLE?: string;
  /** 可用画质预设 (存在表示在直播) */
  VIEWPRESET?: unknown;
  /** AID 认证密钥 (type='aid' 时返回) */
  AID?: string;
  /** 地理位置国家代码 */
  geo_cc?: string;
  /** 地理位置限制代码 */
  geo_rc?: string;
  [key: string]: unknown;
}

export interface SoopPlayerApiResult {
  CHANNEL?: SoopChannelInfo;
  [key: string]: unknown;
}

/** broad_stream_assign.html 响应 */
export interface SoopStreamAssignResult {
  /** 播放地址 (小写 view_url) */
  view_url?: string;
  /** 兼容旧字段名 */
  VIEWURL?: string;
  AID?: string;
  [key: string]: unknown;
}

/** LoginAction.php 响应 */
export interface SoopLoginResult {
  RESULT?: number;
  REASON?: string;
  [key: string]: unknown;
}

/** SOOP 画质映射 (码率) */
export const SoopQualityMappingBit: Record<string, number> = {
  OD: 99999,
  UHD: 4000,
  HD: 2000,
  SD: 1000,
  LD: 600,
};

/** SOOP 画质描述 */
export const SoopQualityDesc: Record<string, string> = {
  OD: '原画',
  UHD: '超清',
  HD: '高清',
  SD: '标清',
  LD: '流畅',
};
