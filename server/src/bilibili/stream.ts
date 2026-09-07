/**
 * Bilibili 流解析逻辑
 * 移植自 biliLive-tools/packages/BilibiliRecorder/src/stream.ts
 * 包含直播状态检测、直播类型判定、画质/格式选择
 */
import { assert } from "../utils.js";
import {
  getRoomInit,
  getRoomPlayInfo,
  getStatusInfoByUIDs,
  getRoomBaseInfo,
  getMasterInfo,
} from "./api.js";
import { BiliQualities, QualityDesc } from "./types.js";
import type {
  ProtocolInfo,
  FormatInfo,
  CodecInfo,
  SourceProfile,
  StreamProfile,
  BiliLiveType,
  RoomPlayInfoData,
} from "./types.js";
import crypto from "node:crypto";

function md5(input: string): string {
  return crypto.createHash("md5").update(input).digest("hex");
}

/** 直播类型描述 */
const LIVE_TYPE_DESC: Record<BiliLiveType, string> = {
  normal: "普通直播",
  paid: "付费直播(DRM 加密)",
  guard: "大航海/权限专属直播",
  password: "密码加密直播",
};

export interface BiliGetInfoResult {
  living: boolean;
  owner: string;
  title: string;
  roomId: number;
  avatar: string;
  cover: string;
  uid: number;
  liveId: string;
  liveStartTime: Date;
  liveType: BiliLiveType;
  liveTypeDesc: string;
  canRecord: boolean;
  isCharge: boolean;
}

/**
 * 获取完整房间信息 + 直播类型判定
 * 判定优先级: 密码房 > 付费标记 > 取流探测(DRM/权限/普通)
 */
export async function getInfo(
  channelId: string,
  opts: { cookie?: string } = {},
): Promise<BiliGetInfoResult> {
  const roomInit = await getRoomInit(Number(channelId));
  const living = roomInit.live_status === 1;

  let owner = "";
  let title = "";
  let avatar = "";
  let cover = "";
  let liveStartTime = new Date(0);

  const { [roomInit.uid]: status } = await getStatusInfoByUIDs([roomInit.uid]).catch(() => ({} as Record<number, any>));
  if (status) {
    owner = status.uname;
    title = status.title;
    avatar = status.face;
    cover = status.cover_from_user;
    liveStartTime = new Date(status.live_time * 1000);
  } else {
    try {
      const base = await getRoomBaseInfo(Number(channelId));
      const info = base[Number(channelId)];
      if (info) {
        owner = info.uname;
        title = info.title;
        cover = info.cover;
        liveStartTime = new Date(info.live_time);
      }
    } catch { /* ignore */ }
  }

  // 头像兜底:主接口失败或无 face 时,用 Master/info 补充头像
  if (!avatar) {
    try {
      const master = await getMasterInfo(roomInit.uid);
      if (master?.info?.face) avatar = master.info.face;
    } catch { /* ignore */ }
  }
  // B 站 face 接口返回 http:// 开头的 CDN 地址;统一转为 https,
  // 避免 https 页面下 <img> 因混合内容被浏览器拦截导致头像无法显示
  avatar = avatar.replace(/^http:\/\//i, "https://");

  let liveType: BiliLiveType = "normal";
  let canRecord = false;

  if (living) {
    const paidByRoomInit = roomInit.is_sp === 1 || roomInit.special_type === 1;
    if (roomInit.encrypted) {
      liveType = "password";
    } else if (paidByRoomInit) {
      liveType = "paid";
    } else {
      try {
        const playInfo = await getRoomPlayInfo(Number(channelId), { cookie: opts.cookie });
        const allSpecialTypes = playInfo.all_special_types ?? [];
        const isDRM = Array.isArray(allSpecialTypes) && allSpecialTypes.includes(203);
        const hasStream = (playInfo.playurl_info?.playurl?.stream?.length ?? 0) > 0;
        if (isDRM) {
          liveType = "paid";
        } else if (!hasStream) {
          liveType = "guard";
        } else {
          liveType = "normal";
          canRecord = true;
        }
      } catch {
        liveType = "normal";
        canRecord = true;
      }
    }
  }

  return {
    uid: roomInit.uid,
    living,
    liveType,
    liveTypeDesc: LIVE_TYPE_DESC[liveType],
    canRecord,
    isCharge: liveType === "paid",
    owner,
    title,
    avatar,
    cover,
    roomId: roomInit.room_id,
    liveStartTime,
    liveId: md5(`${roomInit.room_id}-${liveStartTime.getTime()}`),
  };
}

/** 9 种 protocol/format/codec 组合的默认优先级 */
const DEFAULT_CONDITIONS: Array<{
  protocol_name: ProtocolInfo["protocol_name"];
  format_name: string;
  codec_name: string;
  sort: number;
}> = [
  { protocol_name: "http_stream", format_name: "flv", codec_name: "avc", sort: 9 },
  { protocol_name: "http_hls", format_name: "fmp4", codec_name: "avc", sort: 8 },
  { protocol_name: "http_hls", format_name: "ts", codec_name: "avc", sort: 7 },
  { protocol_name: "http_stream", format_name: "flv", codec_name: "hevc", sort: 6 },
  { protocol_name: "http_hls", format_name: "fmp4", codec_name: "hevc", sort: 5 },
  { protocol_name: "http_hls", format_name: "ts", codec_name: "hevc", sort: 4 },
  { protocol_name: "http_stream", format_name: "flv", codec_name: "av1", sort: 3 },
  { protocol_name: "http_hls", format_name: "fmp4", codec_name: "av1", sort: 2 },
  { protocol_name: "http_hls", format_name: "ts", codec_name: "av1", sort: 1 },
];

interface LiveInfoResult {
  current_qn: number;
  accept_qn: number[];
  base_url: string;
  streams: StreamProfile[];
  sources: SourceProfile[];
  name: string;
  streamOptions: { protocol_name: string; format_name: string; codec_name: string; qn: number };
}

/**
 * 选流核心逻辑：按优先级遍历 protocol/format/codec，找到第一个有流的组合
 */
async function getLiveInfo(
  roomIdOrShortId: number,
  opts: { qn: number; cookie?: string; onlyAudio?: boolean },
): Promise<LiveInfoResult> {
  const res = await getRoomPlayInfo(roomIdOrShortId, opts);
  assert(res.playurl_info, "没有找到流");

  let conditions = [...DEFAULT_CONDITIONS];

  // 默认保持 flv 优先

  let streamInfo: CodecInfo | undefined;
  let streamOptions!: LiveInfoResult["streamOptions"];

  for (const condition of conditions) {
    const streamList = res.playurl_info.playurl.stream
      .find(({ protocol_name }) => protocol_name === condition.protocol_name)
      ?.format.find(({ format_name }) => format_name === condition.format_name)
      ?.codec.filter(({ codec_name }) => codec_name === condition.codec_name);

    if (streamList && streamList.length > 1) {
      streamInfo = streamList.find((item) => item.current_qn === opts.qn);
    }
    if (!streamInfo) {
      streamInfo = streamList?.[0];
    }
    if (streamInfo) {
      streamOptions = { ...condition, qn: streamInfo.current_qn };
      break;
    }
  }
  assert(streamInfo, "没有找到支持的流");

  const streams: StreamProfile[] = streamInfo.accept_qn.map((qn) => {
    const qnDesc = res.playurl_info.playurl.g_qn_desc.find((item) => item.qn === qn);
    assert(qnDesc, "Unexpected getRoomPlayInfo resp");
    return qnDesc;
  });

  const sources: SourceProfile[] = streamInfo.url_info.map((info, idx) => ({
    ...info,
    name: idx === 0 ? "主线" : `备线 ${idx}`,
  }));

  const currentStreamName = res.playurl_info.playurl.g_qn_desc.find(
    (item) => item.qn === streamInfo!.current_qn,
  )?.desc;
  assert(currentStreamName, "Unexpected getRoomPlayInfo resp");

  return {
    current_qn: streamInfo.current_qn,
    accept_qn: streamInfo.accept_qn,
    base_url: streamInfo.base_url,
    streams,
    sources,
    name: currentStreamName,
    streamOptions,
  };
}

export interface BiliStreamResult {
  url: string;
  name: string;
  source: string;
  current_qn: number;
  accept_qn: number[];
  streams: StreamProfile[];
}

/**
 * 获取流地址（对外主入口）
 * 默认请求最高画质 qn=10000(原画)，画质不匹配时自动降级
 */
export async function getStream(opts: {
  channelId: string;
  quality?: number;
  cookie?: string;
  onlyAudio?: boolean;
}): Promise<BiliStreamResult> {
  const roomId = Number(opts.channelId);
  const qn = BiliQualities.includes(opts.quality as any) ? (opts.quality as number) : 10000;

  let liveInfo = await getLiveInfo(roomId, { qn, cookie: opts.cookie, onlyAudio: opts.onlyAudio });

  // 画质降级：当前画质不是期望的，用 accept_qn[0] 重试
  if ((liveInfo?.accept_qn ?? []).length !== 0 && liveInfo.current_qn !== qn) {
    const acceptQn = liveInfo.accept_qn[0];
    liveInfo = await getLiveInfo(roomId, { qn: acceptQn, cookie: opts.cookie, onlyAudio: opts.onlyAudio });
  }

  const expectSource = liveInfo.sources[0];
  assert(expectSource, "Can not get expect source");

  const url = expectSource.host + liveInfo.base_url + expectSource.extra;

  return {
    url,
    name: liveInfo.name,
    source: expectSource.name,
    current_qn: liveInfo.current_qn,
    accept_qn: liveInfo.accept_qn,
    streams: liveInfo.streams,
  };
}
