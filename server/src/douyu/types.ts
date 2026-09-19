/**
 * 斗鱼直播 API 类型定义
 * 移植自 biliup crates/biliup/src/downloader/live/douyu.rs
 */

/** betard 房间信息接口响应 */
export interface DouyuBetardResponse {
  room?: DouyuBetardRoom | null;
}

/** betard 房间信息 (字段与斗鱼页面数据一致) */
export interface DouyuBetardRoom {
  room_name: string;
  show_status: number;
  /** 0=正常直播; 非 0 表示轮播/录像 */
  videoLoop: number;
  /** 主播昵称 (页面/接口存在时使用) */
  nickname?: string;
  /** 主播头像 */
  avatar?: string;
  [key: string]: unknown;
}

/** getEncryption 接口响应 */
export interface DouyuEncryptionResponse {
  error: number;
  msg?: string;
  data?: DouyuEncryptKey | null;
}

/** getEncryption 返回的加密密钥 */
export interface DouyuEncryptKey {
  rand_str: string;
  enc_time: number;
  is_special: number;
  key: string;
  enc_data: string;
  /** 过期时间 (10 位 Unix 时间戳; 缺失默认 0 视为立即过期) */
  expire_at?: number;
}

/** getH5PlayV1 接口响应 */
export interface DouyuPlayResponse {
  error: number;
  msg?: string;
  data?: DouyuPlayInfo | null;
}

/** getH5PlayV1 播放信息 */
export interface DouyuPlayInfo {
  rtmp_url: string;
  rtmp_live: string;
  rtmp_cdn?: string;
  cdnsWithName?: Array<{ cdn?: string | null }>;
}
