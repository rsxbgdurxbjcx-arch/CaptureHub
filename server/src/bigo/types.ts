/**
 * Bigo Live 直播 API 类型定义
 * 移植自 biliup crates/biliup/src/downloader/live/bigo.rs
 * 参考 streamlink/youtube-dl 的字段补充
 */

/** getInternalStudioInfo 响应 */
export interface BigoStudioInfoResponse {
  code: number;
  msg?: string;
  data?: BigoStudioData | null;
}

/** getInternalStudioInfo 响应 data 字段 (字段名以真实响应为准) */
export interface BigoStudioData {
  /** 内部房间 sid */
  sid?: number | null;
  /** 请求回显的 siteId */
  siteId?: string;
  /** 主播 uid */
  uid?: number | null;
  /** 主播头像 */
  avatar?: string;
  /** 主播昵称 */
  nick_name?: string;
  /** 游戏/分类标题 */
  gameTitle?: string;
  /** 房间主题 (直播标题) */
  roomTopic?: string;
  /** 备份头像/封面 */
  snapshot?: string;
  /** 是否在直播: 1=在播 */
  alive?: number;
  /** 真实房间 ID (离线时为 "0") */
  roomId?: string | number | null;
  /** 房间状态 */
  roomStatus?: number;
  /** HLS 拉流地址 (在播时非空) */
  hls_src?: string | null;
  /** 主播 Bigo ID */
  clientBigoId?: string | null;
}
