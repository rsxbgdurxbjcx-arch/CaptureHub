/**
 * Pandalive 直播 API 层
 * 移植自 StreamCap/StreamGet 的 Pandalive 模块
 * 将 Python aiohttp/requests 替换为 undici，适配 red 项目
 *
 * Pandalive 关键接口 (与 StreamGet 完全一致):
 * - 主播信息: POST https://api.pandalive.co.kr/v1/member/bj (form: userId, info=media fanGrade)
 * - 播放地址: POST https://api.pandalive.co.kr/v1/live/play (form: action=watch, userId, password, shareLinkType='')
 * - 播放地址位于 json.PlayList.hls[0].url
 * - 错误信息位于 json.errorData (如 needAdult 需要登录Cookie)
 */
import { fetch as undiciFetch } from "undici";
import type {
  PandaliveMemberInfo,
  PandalivePlayResult,
} from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0";

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": DEFAULT_UA,
  "Origin": "https://www.pandalive.co.kr",
  "Referer": "https://www.pandalive.co.kr/",
};

const MEMBER_API = "https://api.pandalive.co.kr/v1/member/bj";
const PLAY_API = "https://api.pandalive.co.kr/v1/live/play";

interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

async function doPost(
  url: string,
  body: URLSearchParams,
  options: FetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = options.timeout ?? 15000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      ...options.headers,
    };
    return (await undiciFetch(url, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: controller.signal,
      redirect: "follow" as const,
    } as any)) as Response;
  } finally {
    clearTimeout(timer);
  }
}

async function doGet(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = options.timeout ?? 15000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return (await undiciFetch(url, {
      method: "GET",
      headers: { ...DEFAULT_HEADERS, ...options.headers },
      signal: controller.signal,
      redirect: "follow" as const,
    } as any)) as Response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 获取 Pandalive 主播信息（直播状态 + 用户信息）
 * POST https://api.pandalive.co.kr/v1/member/bj
 * form: userId={userId}&info=media fanGrade
 *
 * 响应中 media 字段存在表示在直播
 * 主播信息位于 bjInfo.id / bjInfo.nick
 */
export async function fetchMemberInfo(
  userId: string,
  cookie?: string,
): Promise<PandaliveMemberInfo> {
  const params = new URLSearchParams();
  params.set("userId", userId);
  params.set("info", "media fanGrade");

  const headers: Record<string, string> = {};
  if (cookie) headers["Cookie"] = cookie;

  const resp = await doPost(MEMBER_API, params, { headers });
  return (await resp.json()) as PandaliveMemberInfo;
}

/**
 * 获取直播播放地址
 * POST https://api.pandalive.co.kr/v1/live/play
 * form: action=watch, userId, password, shareLinkType=''
 *
 * 播放地址位于 json.PlayList.hls[0].url
 * 错误信息位于 json.errorData (如 needAdult)
 */
export async function fetchPlayInfo(
  userId: string,
  password?: string,
  cookie?: string,
): Promise<PandalivePlayResult> {
  const params = new URLSearchParams();
  params.set("action", "watch");
  params.set("userId", userId);
  params.set("password", password || "");
  params.set("shareLinkType", "");

  const headers: Record<string, string> = {};
  if (cookie) headers["Cookie"] = cookie;

  const resp = await doPost(PLAY_API, params, { headers });
  const result = (await resp.json()) as PandalivePlayResult;

  // 检查错误 (与 StreamGet 一致)
  if (result.errorData) {
    const code = result.errorData.code || '';
    if (code === 'needAdult') {
      throw new Error(
        '该直播间需要登录且仅限成人观看，请在设置中正确填写 Pandalive 登录 Cookie',
      );
    }
    throw new Error(
      `Pandalive API 错误: ${code} ${result.errorData.message || result.message || ''}`,
    );
  }

  return result;
}

/**
 * 获取流地址（从 live/play 返回的 PlayList.hls[0].url）
 */
export async function fetchStreamUrl(
  userId: string,
  password?: string,
  cookie?: string,
): Promise<string> {
  const play = await fetchPlayInfo(userId, password, cookie);
  const hlsUrl = play.PlayList?.hls?.[0]?.url;
  if (!hlsUrl) {
    throw new Error("Pandalive live/play 未返回有效的 HLS 地址");
  }
  return hlsUrl;
}

/**
 * 获取 M3U8 播放列表内容（用于解析多画质变体）
 */
export async function fetchM3u8Content(
  m3u8Url: string,
  cookie?: string,
): Promise<string> {
  const headers: Record<string, string> = {};
  if (cookie) headers["Cookie"] = cookie;
  const resp = await doGet(m3u8Url, { headers });
  return await resp.text();
}
