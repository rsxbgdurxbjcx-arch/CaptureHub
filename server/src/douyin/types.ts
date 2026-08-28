export type APIType = "web" | "webHTML" | "mobile" | "userHTML" | "balance" | "random";
export type RealAPIType = Exclude<APIType, "balance" | "random">;

export interface RoomInfo {
  living: boolean;
  nickname: string;
  sec_uid: string;
  avatar: string;
  api: RealAPIType;
  // 是否为直播电台
  isLiveRadio: boolean;
  room: {
    title: string;
    cover: string;
    id_str: string;
    stream_url: any | null;
  } | null;
}

/**
 * 流数据结构（来自直播API响应）
 */
export interface StreamData {
  common: unknown;
  data: Record<
    string,
    {
      main: {
        flv: string;
        hls: string;
        cmaf: string;
        dash: string;
        lls: string;
        tsl: string;
        tile: string;
        sdk_params: string;
      };
    }
  >;
}

/**
 * 流画质信息（来自API的qualities列表）
 */
export interface StreamProfile {
  desc: string;
  key: string;
  bitRate: number;
}

/**
 * 单条流信息
 */
export interface StreamInfo {
  quality: string;
  name: string;
  flv?: string;
  hls?: string;
  /**
   * 视频编码类别(由 sdk_params.VCodec 归一化):
   * 'h264' | 'h265' | 'bytevc1' | 其他小写编码名 | undefined(未知)
   * 抖音直播支持 H.265 / ByteVC1 等编码,部分流直接录制后
   * 在 Telegram 等平台会出现"只有声音、画面马赛克"的问题。
   */
  codec?: string;
}

/**
 * 流来源（线路）
 */
export interface SourceProfile {
  name: string;
  streamMap: StreamData["data"];
  streams: StreamInfo[];
}

/**
 * 画质信息（API响应中的画质描述）
 */
export interface QualityInfo {
  name: string;
  sdk_key: string;
  v_codec: string;
  resolution: string;
  level: number;
  v_bit_rate: number;
  additional_content: string;
  fps: number;
  disable: number;
}
