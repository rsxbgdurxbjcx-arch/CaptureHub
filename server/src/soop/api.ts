/**
 * SOOP (formerly AfreecaTV) 直播 API 层
 * 完全移植自 移植自StreamCap 的 streamget 的 SOOP 模块
 * https://github.com/ihmily/streamget/blob/main/streamget/platforms/soop/live_stream.py
 *
 * 关键接口 (与 streamget 完全一致):
 * - 站点状态: https://st.sooplive.com/api/get_station_status.php?szBjId={bjId}
 * - 播放器 API: https://live.sooplive.com/afreeca/player_live_api.php?bjid={bjId} (POST)
 * - 流分配:   http://livestream-manager.sooplive.com/broad_stream_assign.html (GET)
 * - 登录:     https://login.sooplive.com/app/LoginAction.php (POST)
 *
 * 重要: streamget 不检测 geo_cc / geo_rc 地理位置限制字段。
 * RESULT=0 表示 API 调用成功，VIEWPRESET 存在表示在直播。
 * geo_cc 字段仅为信息性返回，不构成限制。
 */
import { fetch as undiciFetch } from "undici";
import type {
  SoopStationStatus,
  SoopPlayerApiResult,
  SoopStreamAssignResult,
  SoopLoginResult,
  SoopChannelInfo,
} from "./types.js";

/** Firefox UA — 与 streamget _get_pc_headers 完全一致 */
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0";

/** PC 端请求头 — 与 streamget _get_pc_headers 一致 */
function makePcHeaders(cookie?: string): Record<string, string> {
  return {
    "user-agent": DEFAULT_UA,
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    origin: "https://play.sooplive.com",
    referer: "https://play.sooplive.com/superbsw123/277837074",
    cookie: cookie || "",
  };
}

const STATION_API = "https://st.sooplive.com/api/get_station_status.php";
const PLAYER_API = "https://live.sooplive.com/afreeca/player_live_api.php";
const STREAM_ASSIGN_API =
  "http://livestream-manager.sooplive.com/broad_stream_assign.html";
const LOGIN_API = "https://login.sooplive.com/app/LoginAction.php";

interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
  redirect?: "follow" | "manual";
}

async function doGet(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = options.timeout ?? 20000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return (await undiciFetch(url, {
      method: "GET",
      headers: { ...options.headers },
      signal: controller.signal,
      redirect: "follow" as const,
      // undici fetch does not verify TLS by default, matching streamget's verify=False
    } as any)) as Response;
  } finally {
    clearTimeout(timer);
  }
}

async function doPost(
  url: string,
  body: URLSearchParams,
  options: FetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = options.timeout ?? 20000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return (await undiciFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...options.headers,
      },
      body: body.toString(),
      signal: controller.signal,
      // httpx POST does not follow redirects by default — match that behavior
      redirect: (options.redirect ?? "manual") as "follow" | "manual",
    } as any)) as Response;
  } finally {
    clearTimeout(timer);
  }
}

/** 从响应的 set-cookie 头解析出 cookie 字符串 */
function parseSetCookie(resp: Response): string {
  const cookies: string[] = [];
  const setCookieHeaders = resp.headers.getSetCookie?.() ?? [];
  for (const sc of setCookieHeaders) {
    const parts = sc.split(";");
    if (parts.length > 0 && parts[0].includes("=")) {
      cookies.push(parts[0].trim());
    }
  }
  // 去重
  return [...new Set(cookies)].join("; ");
}

/**
 * 获取 SOOP 主播站点状态（直播状态 + 用户信息）
 * API: https://st.sooplive.com/api/get_station_status.php?szBjId={bjId}
 *
 * 响应结构: { RESULT: 1, DATA: { user_nick, broad_start, ... } }
 */
export async function fetchStationStatus(
  bjId: string,
  cookie?: string,
): Promise<SoopStationStatus> {
  const url = `${STATION_API}?szBjId=${encodeURIComponent(bjId)}`;
  const headers = makePcHeaders(cookie);
  const resp = await doGet(url, { headers });
  const text = await resp.text();
  try {
    return JSON.parse(text) as SoopStationStatus;
  } catch {
    console.error(`[soop] get_station_status 返回非 JSON: ${text.slice(0, 200)}`);
    throw new Error(`SOOP get_station_status 返回非 JSON 响应`);
  }
}

/**
 * 获取主播昵称 (从 station status 的 DATA.user_nick)
 * 与 streamget get_sooplive_user_nick 一致
 */
export async function fetchUserNick(
  bjId: string,
  cookie?: string,
): Promise<string> {
  const station = await fetchStationStatus(bjId, cookie);
  return String(station.DATA?.user_nick || bjId);
}

/**
 * 获取 SOOP 主播头像 URL
 *
 * 使用 SOOP 站点头像 CDN 的固定规范直接拼接(无需调用任何接口):
 *   https://profile.img.sooplive.co.kr/LOGO/{ID前两个字符}/{完整ID}/{完整ID}.jpg
 * 示例: bjId=mj0128 → https://profile.img.sooplive.co.kr/LOGO/mj/mj0128/mj0128.jpg
 *
 * 说明:
 * - 该机制为纯 URL 拼接, 不依赖 station API, 不校验头像是否存在;
 * - 若主播无头像导致图片加载失败, 前端自动回退显示占位符。
 *
 * @param bjId 主播 ID
 * @returns 主播头像 URL(拼接结果;bjId 为空时返回空字符串)
 */
export function fetchStationAvatar(bjId: string): string {
  const id = bjId.trim();
  if (!id) return "";
  const prefix = id.slice(0, 2).toLowerCase();
  return `https://profile.img.sooplive.co.kr/LOGO/${prefix}/${id}/${id}.jpg`;
}

/**
 * 调用 player_live_api 获取直播元数据
 * POST https://live.sooplive.com/afreeca/player_live_api.php?bjid={bjId}
 *
 * 参数与 streamget get_sooplive_tk 完全一致:
 * - bid: 主播ID, bno: 空, type: rtype ('' 或 'aid'), pwd: 空
 * - player_type: 'html5', stream_type: 'common', quality: 'master'
 * - mode: 'landing', from_api: '0', is_revive: 'false'
 *
 * 响应结构: { CHANNEL: { RESULT, BNO, TITLE, VIEWPRESET, AID, geo_cc, ... } }
 *
 * @param bjId   主播 ID
 * @param rtype  请求类型: '' = 获取直播信息, 'aid' = 获取认证密钥
 * @param cookie cookie 字符串
 * @returns CHANNEL 对象
 */
export async function fetchPlayerApi(
  bjId: string,
  rtype: string,
  cookie?: string,
): Promise<SoopChannelInfo> {
  const params = new URLSearchParams();
  params.set("bid", bjId);
  params.set("bno", "");
  params.set("type", rtype);
  params.set("pwd", "");
  params.set("player_type", "html5");
  params.set("stream_type", "common");
  params.set("quality", "master");
  params.set("mode", "landing");
  params.set("from_api", "0");
  params.set("is_revive", "false");

  const url = `${PLAYER_API}?bjid=${encodeURIComponent(bjId)}`;
  const headers = makePcHeaders(cookie);

  const resp = await doPost(url, params, { headers });
  const text = await resp.text();
  try {
    const data = JSON.parse(text) as SoopPlayerApiResult;
    return data.CHANNEL || {};
  } catch {
    console.error(`[soop] player_live_api 返回非 JSON: ${text.slice(0, 200)}`);
    throw new Error(`SOOP player_live_api 返回非 JSON 响应`);
  }
}

/**
 * 调用 broad_stream_assign 获取播放地址
 * http://livestream-manager.sooplive.com/broad_stream_assign.html
 *
 * 参数与 streamget _get_sooplive_cdn_url 完全一致:
 * - return_type: 'gcp_cdn'
 * - use_cors: 'false'
 * - cors_origin_url: 'play.sooplive.com'
 * - broad_key: '{bno}-common-master-hls'
 * - time: '3061.2892404235236'
 *
 * 响应: { view_url: "https://..." }
 */
export async function fetchStreamAssign(
  broadNo: string,
  cookie?: string,
): Promise<SoopStreamAssignResult> {
  const params = new URLSearchParams();
  params.set("return_type", "gcp_cdn");
  params.set("use_cors", "false");
  params.set("cors_origin_url", "play.sooplive.com");
  params.set("broad_key", `${broadNo}-common-master-hls`);
  params.set("time", "3061.2892404235236");

  const url = `${STREAM_ASSIGN_API}?${params.toString()}`;
  const headers = makePcHeaders(cookie);

  const resp = await doGet(url, { headers });
  const text = await resp.text();
  try {
    return JSON.parse(text) as SoopStreamAssignResult;
  } catch {
    console.error(`[soop] broad_stream_assign 返回非 JSON: ${text.slice(0, 200)}`);
    throw new Error(`SOOP broad_stream_assign 返回非 JSON 响应`);
  }
}

/**
 * 解析 m3u8 主播放列表，获取子流 URL 列表
 * 与 streamget _get_url_list 完全一致
 *
 * 从 master m3u8 中提取子播放列表 URL，按带宽降序排列
 *
 * @param m3u8Url master m3u8 URL (含 aid 参数)
 * @param cookie  cookie 字符串
 * @returns 按带宽降序排列的子播放列表 URL 数组
 */
export async function fetchUrlList(
  m3u8Url: string,
  cookie?: string,
): Promise<string[]> {
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  };

  const resp = await doGet(m3u8Url, { headers });
  const text = await resp.text();

  const playUrlList: string[] = [];
  // Python: m3u8.rsplit('/', maxsplit=1)[0] — 取最后一个 '/' 之前的部分
  const lastSlashIdx = m3u8Url.lastIndexOf("/");
  const urlPrefix = lastSlashIdx >= 0 ? m3u8Url.substring(0, lastSlashIdx) : m3u8Url;

  for (const line of text.split("\n")) {
    if (!line.startsWith("#") && line.trim()) {
      playUrlList.push(`${urlPrefix}/${line.trim()}`);
    }
  }

  // 按 BANDWIDTH 降序排列
  const bandwidthPattern = /BANDWIDTH=(\d+)/g;
  const bandwidthList: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = bandwidthPattern.exec(text)) !== null) {
    bandwidthList.push(parseInt(match[1], 10));
  }

  const urlToBandwidth = new Map<string, number>();
  for (let i = 0; i < bandwidthList.length && i < playUrlList.length; i++) {
    urlToBandwidth.set(playUrlList[i], bandwidthList[i]);
  }

  playUrlList.sort((a, b) => {
    const bwA = urlToBandwidth.get(a) ?? 0;
    const bwB = urlToBandwidth.get(b) ?? 0;
    return bwB - bwA;
  });

  return playUrlList;
}

/** 画质 → 索引映射 (与 streamget get_quality_index 一致) */
const QUALITY_MAPPING: Record<string, number> = {
  OD: 0,
  UHD: 1,
  HD: 2,
  SD: 3,
  LD: 4,
};

/**
 * 根据画质选择播放 URL
 * 与 streamget get_stream_url 中的逻辑一致
 *
 * @param playUrlList 子播放列表 URL 数组 (按带宽降序)
 * @param quality     期望画质 (OD/UHD/HD/SD/LD)
 * @returns 选中的播放 URL
 */
export function selectQualityUrl(
  playUrlList: string[],
  quality?: string,
): string | null {
  if (playUrlList.length === 0) return null;

  const qualityStr = (quality || "OD").toUpperCase();
  let selectedIndex = QUALITY_MAPPING[qualityStr] ?? 0;

  // 与 streamget 一致: 不足 5 个时用最后一个填充
  const filledList = [...playUrlList];
  while (filledList.length < 5) {
    filledList.push(filledList[filledList.length - 1]);
  }

  if (selectedIndex >= filledList.length) {
    selectedIndex = 0;
  }

  return filledList[selectedIndex];
}

/**
 * 获取流地址 (完整流程，与 streamget fetch_web_stream_data 一致)
 *
 * 流程:
 * 1. 调用 player_live_api (type='') 获取 RESULT / VIEWPRESET / TITLE / BNO
 * 2. 若 RESULT 不在 [0,1]，表示需要登录，返回 result 让调用方处理
 * 3. 若 VIEWPRESET 存在 (表示在直播):
 *    a. 调用 broad_stream_assign 获取 view_url
 *    b. 调用 player_live_api (type='aid') 获取 AID
 *    c. m3u8_url = view_url + '?aid=' + AID
 *    d. 解析 master m3u8 获取 play_url_list (各画质子流 URL)
 * 4. 返回 m3u8_url, play_url_list 和相关信息
 *
 * 重要: 不检测 geo_cc 地理位置限制 — streamget 也不检测。
 * RESULT=0 表示成功，VIEWPRESET 存在表示在直播。
 *
 * @returns { m3u8Url, playUrlList, title, broadNo, result, isLive }
 */
export async function fetchStreamUrl(
  bjId: string,
  cookie?: string,
): Promise<{
  m3u8Url: string | null;
  playUrlList: string[];
  title: string;
  broadNo: string;
  result: number;
  isLive: boolean;
}> {
  // Step 1: 调用 player_live_api (type='') 获取直播信息
  const channel = await fetchPlayerApi(bjId, "", cookie);
  const result = channel.RESULT ?? -1;
  const broadNo = String(channel.BNO || "");
  const title = String(channel.TITLE || "");
  // VIEWPRESET 存在表示在直播 (与 streamget 的 if status: 一致)
  const hasViewPreset = !!channel.VIEWPRESET;

  console.log(
    `[soop] player_live_api: RESULT=${result}, BNO=${broadNo || "无"}, ` +
    `VIEWPRESET=${hasViewPreset ? "有(直播中)" : "无(未开播)"}`,
  );

  // RESULT 不在 [0,1] 表示需要登录
  if (result !== 0 && result !== 1) {
    return {
      m3u8Url: null,
      playUrlList: [],
      title,
      broadNo,
      result,
      isLive: false,
    };
  }

  // VIEWPRESET 不存在表示未开播
  if (!hasViewPreset) {
    return {
      m3u8Url: null,
      playUrlList: [],
      title,
      broadNo,
      result,
      isLive: false,
    };
  }

  // Step 2: 获取 CDN URL
  const assignResult = await fetchStreamAssign(broadNo, cookie);
  const viewUrl = assignResult.view_url || assignResult.VIEWURL;
  if (!viewUrl) {
    console.error(
      `[soop] broad_stream_assign 未返回 view_url:`,
      JSON.stringify(assignResult).slice(0, 300),
    );
    throw new Error("SOOP broad_stream_assign 未返回 view_url");
  }

  // Step 3: 获取 AID 认证密钥
  const aidChannel = await fetchPlayerApi(bjId, "aid", cookie);
  const aid = aidChannel.AID;

  const m3u8Url = aid ? `${viewUrl}?aid=${aid}` : viewUrl;
  console.log(`[soop] 流地址获取成功: ${m3u8Url.slice(0, 80)}...`);

  // Step 4: 解析 master m3u8 获取各画质子流 URL (与 streamget _get_url_list 一致)
  let playUrlList: string[] = [];
  try {
    playUrlList = await fetchUrlList(m3u8Url, cookie);
    console.log(`[soop] 解析到 ${playUrlList.length} 个画质子流`);
  } catch (e) {
    console.warn(`[soop] 解析 m3u8 播放列表失败, 使用 master URL: ${e instanceof Error ? e.message : e}`);
    playUrlList = [];
  }

  return {
    m3u8Url,
    playUrlList,
    title,
    broadNo,
    result,
    isLive: true,
  };
}

/**
 * SOOP 登录
 * POST https://login.sooplive.com/app/LoginAction.php
 * 参数与 streamget login_sooplive 完全一致
 *
 * @returns 登录成功后的 cookie 字符串
 */
export async function loginSoop(
  username: string,
  password: string,
): Promise<string> {
  if (!username || !password) {
    throw new Error("SOOP 登录需要提供用户名和密码");
  }

  // 与 streamget 一致的参数校验
  if (username.length < 6 || password.length < 10) {
    throw new Error(
      "SOOP 登录失败: 用户名需至少6位，密码需至少10位",
    );
  }

  const params = new URLSearchParams();
  params.set("szWork", "login");
  params.set("szType", "json");
  params.set("szUid", username);
  params.set("szPassword", password);
  params.set("isSaveId", "true");
  params.set("isSavePw", "true");
  params.set("isSaveJoin", "true");
  params.set("isLoginRetain", "Y");

  const resp = await doPost(LOGIN_API, params, {
    headers: makePcHeaders(),
    redirect: "manual",
  });

  const cookie = parseSetCookie(resp);
  if (!cookie) {
    // 尝试解析 JSON 确认登录是否失败
    try {
      const data = (await resp.json()) as SoopLoginResult;
      if (data.RESULT !== 1) {
        throw new Error(`SOOP 登录失败: ${data.REASON || "未知原因"}`);
      }
    } catch {
      throw new Error("SOOP 登录失败: 未返回有效的 Cookie");
    }
  }
  console.log(`[soop] 登录成功, cookie 长度: ${cookie.length}`);
  return cookie;
}
