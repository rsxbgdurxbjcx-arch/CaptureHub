/**
 * Bilibili 直播 API 类型定义
 * 移植自 biliLive-tools/packages/BilibiliRecorder/src/bilibili_api.ts
 */

export type LiveStatus = 0 | 1 | 2; // 0=未开播 1=直播中 2=轮播中

export interface BilibiliResp<T = unknown> {
  code: number;
  message: string;
  msg?: string;
  data: T;
}

export interface RoomInitData {
  room_id: number;
  short_id: number;
  uid: number;
  live_status: LiveStatus;
  live_time: number;
  encrypted: boolean;
  is_sp: 0 | 1;
  special_type: number;
}

export interface RoomInfoData {
  room_id: number;
  short_id: number;
  uid: number;
  attention: number;
  online: number;
  description: string;
  title: string;
  user_cover: string;
  live_status: LiveStatus;
  live_time: string;
  pk_status: number;
}

export interface StatusInfoByUID {
  title: string;
  uname: string;
  face: string;
  live_status: LiveStatus;
  cover_from_user: string;
  live_time: number;
  online: number;
  room_id: number;
  short_id: number;
  area_v2_parent_name: string;
}

export interface RoomBaseInfo {
  title: string;
  uname: string;
  live_time: string;
  live_status: LiveStatus;
  cover: string;
  is_encrypted: boolean;
}

export interface StreamProfile {
  desc: string;
  qn: number;
}

export interface SourceProfile {
  name: string;
  host: string;
  extra: string;
  stream_ttl: number;
}

export interface CodecInfo {
  codec_name: string;
  accept_qn: number[];
  base_url: string;
  current_qn: number;
  url_info: Omit<SourceProfile, "name">[];
}

export interface FormatInfo {
  format_name: string;
  codec: CodecInfo[];
}

export interface ProtocolInfo {
  protocol_name: "http_stream" | "http_hls";
  format: FormatInfo[];
}

export interface RoomPlayInfoData {
  uid: number;
  room_id: number;
  short_id: number;
  live_status: LiveStatus;
  live_time: number;
  all_special_types?: number[];
  playurl_info: {
    conf_json: string;
    playurl: {
      g_qn_desc: StreamProfile[];
      stream: ProtocolInfo[];
    };
  };
}

/** B站画质常量（数字越大画质越高） */
export const BiliQualities = [30000, 20000, 25000, 15000, 10000, 400, 250, 150, 80] as const;

/** 画质描述映射 */
export const QualityDesc: Record<number, string> = {
  30000: "杜比",
  20000: "4K",
  25000: "8K",
  15000: "原画",
  10000: "原画",
  400: "蓝光",
  250: "超清",
  150: "高清",
  80: "流畅",
};

export type BiliLiveType = "normal" | "paid" | "guard" | "password";
