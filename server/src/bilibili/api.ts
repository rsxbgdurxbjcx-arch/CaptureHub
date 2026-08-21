/**
 * Bilibili 直播 API 层
 * 移植自 biliLive-tools/packages/BilibiliRecorder/src/bilibili_api.ts
 * 将 axios 替换为 undici，适配 red 项目
 */
import { fetch as undiciFetch } from "undici";
import { URL, URLSearchParams } from "url";
import { assert } from "../utils.js";
import type {
  BilibiliResp,
  LiveStatus,
  RoomInitData,
  RoomInfoData,
  StatusInfoByUID,
  RoomBaseInfo,
  RoomPlayInfoData,
  StreamProfile,
} from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

async function doFetch(url: string, options: { headers?: Record<string, string>; timeout?: number } = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = options.timeout ?? 10000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return (await undiciFetch(url, {
      method: "GET",
      headers: { "User-Agent": DEFAULT_UA, ...options.headers },
      signal: controller.signal,
      redirect: "follow" as const,
    } as any)) as Response;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const resp = await doFetch(url, { headers });
  const data = (await resp.json()) as BilibiliResp<T>;
  assert(data.code === 0, `Unexpected resp, code ${data.code}, msg ${data.message}`);
  return data.data;
}

/** 房间初始化（短号→长号、uid、live_status、encrypted、is_sp、special_type） */
export async function getRoomInit(roomIdOrShortId: number): Promise<RoomInitData> {
  return getJson<RoomInitData>(
    `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomIdOrShortId}`,
  );
}

/** 房间详情（标题、封面、online、live_time） */
export async function getRoomInfo(roomIdOrShortId: number): Promise<RoomInfoData> {
  return getJson<RoomInfoData>(
    `https://api.live.bilibili.com/room/v1/Room/get_info?id=${roomIdOrShortId}`,
  );
}

/** 主播信息 */
export async function getMasterInfo(userId: number) {
  const resp = await doFetch(
    `https://api.live.bilibili.com/live_user/v1/Master/info?uid=${userId}`,
  );
  const data = (await resp.json()) as BilibiliResp<{
    info: { uname: string; face: string };
    exp: { level: number };
    follower_num: number;
    medal_name: string;
  }>;
  assert(data.code === 0, `Unexpected resp, code ${data.code}, msg ${data.message}`);
  return data.data;
}

/** 批量按 UID 查直播状态 */
export async function getStatusInfoByUIDs(userIds: number[]): Promise<Record<number, StatusInfoByUID>> {
  const params = new URLSearchParams();
  params.set("uids", JSON.stringify(userIds));
  return getJson<Record<number, StatusInfoByUID>>(
    `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?${params.toString()}`,
  );
}

/** 房间基础信息（含 is_encrypted） */
export async function getRoomBaseInfo(roomId: number): Promise<Record<number, RoomBaseInfo>> {
  return getJson<{ by_room_ids: Record<number, RoomBaseInfo> }>(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?room_ids=${roomId}&req_biz=web_room_componet`,
  ).then((d) => d.by_room_ids);
}

/** 主用取流接口（V2） */
export async function getRoomPlayInfo(
  roomIdOrShortId: number,
  opts: { qn?: number; cookie?: string; onlyAudio?: boolean } = {},
): Promise<RoomPlayInfoData> {
  const params = new URLSearchParams();
  params.set("room_id", String(roomIdOrShortId));
  if (opts.qn) params.set("qn", String(opts.qn));
  params.set("protocol", "0,1");
  params.set("codec", "0,1,2");
  params.set("format", "0,1,2");
  params.set("only_audio", opts.onlyAudio ? "1" : "0");

  const headers: Record<string, string> = {};
  if (opts.cookie) headers["Cookie"] = opts.cookie;

  return getJson<RoomPlayInfoData>(
    `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${params.toString()}`,
    headers,
  );
}
