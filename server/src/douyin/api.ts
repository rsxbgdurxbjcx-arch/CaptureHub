import { fetch as undiciFetch, ProxyAgent } from "undici";
import { URL, URLSearchParams } from "url";
import { assert, get__ac_signature } from "./utils.js";
import { ABogus } from "./sign.js";
import type {
  APIType,
  RoomInfo,
  RealAPIType,
  StreamProfile,
  StreamInfo,
  SourceProfile,
  StreamData,
  QualityInfo,
} from "./types.js";

// ============================================================================
// 常量与配置
// ============================================================================

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0";

export const qualityList = [
  {
    key: "origin",
    desc: "原画",
  },
  {
    key: "uhd",
    desc: "蓝光",
  },
  {
    key: "hd",
    desc: "超清",
  },
  {
    key: "sd",
    desc: "高清",
  },
  {
    key: "ld",
    desc: "标清",
  },
  {
    key: "ao",
    desc: "音频流",
  },
  {
    key: "real_origin",
    desc: "真原画",
  },
];

// ============================================================================
// fetch 封装（替代 axios requester）
// ============================================================================

let proxyDispatcher: ProxyAgent | undefined;

/**
 * 设置全局代理（供 DouyinParser 调用）
 */
export function setProxy(proxy?: string): void {
  proxyDispatcher = proxy ? new ProxyAgent(proxy) : undefined;
}

interface DoFetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

/**
 * 模块级 fetch 封装，设置默认 UA 和 timeout
 * 替代原 axios.create({ timeout: 10e3, proxy: false, headers: { "User-Agent": ... } })
 */
async function doFetch(url: string, options: DoFetchOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = options.timeout ?? 10000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const fetchOptions: Record<string, unknown> = {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_UA,
        ...options.headers,
      },
      signal: controller.signal,
      redirect: "follow" as const,
    };
    if (proxyDispatcher) {
      fetchOptions.dispatcher = proxyDispatcher;
    }
    return (await undiciFetch(url, fetchOptions as any)) as Response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 Response 中提取 set-cookie 头（兼容 Node 20+ 的 getSetCookie 方法）
 * 替代 axios 的 res.headers['set-cookie']
 */
function getSetCookieHeaders(resp: Response): string[] {
  const headers = resp.headers as any;
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie() as string[];
  }
  // Fallback: 尝试从原始头获取
  const raw = resp.headers.get("set-cookie");
  return raw ? [raw] : [];
}

/**
 * 原生 isEmpty 实现，替代 lodash-es 的 isEmpty
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" || Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

// ============================================================================
// Cookie 缓存与获取
// ============================================================================

let cookieCache: {
  startTimestamp: number;
  cookies: string;
} | undefined;

/**
 * 获取 ttwid cookie（6小时缓存）
 */
export const getCookie = async (): Promise<string> => {
  const now = new Date().getTime();
  // 缓存6小时
  if (cookieCache?.startTimestamp && now - cookieCache.startTimestamp < 6 * 60 * 60 * 1000) {
    return cookieCache.cookies;
  }
  const resp = await doFetch("https://live.douyin.com/");
  const setCookies = getSetCookieHeaders(resp);
  if (setCookies.length === 0) {
    throw new Error("No cookie in response");
  }
  const cookies = setCookies
    .map((cookie: string) => {
      return cookie.split(";")[0];
    })
    .join("; ");

  if (!cookies.includes("ttwid")) {
    // 如果不含ttwid，且已经存在含ttwid的cookie，将缓存时间直接增加1小时，复用之前的参数
    if (cookieCache?.cookies) {
      cookieCache.startTimestamp += 60 * 60 * 1000; // 增加1小时
      return cookieCache.cookies;
    }
  }

  cookieCache = {
    startTimestamp: now,
    cookies,
  };
  return cookies;
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成随机 nonce（21位随机字母数字组合）
 */
export function generateNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let nonce = "";
  for (let i = 0; i < 21; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/**
 * 随机选择一个可用的 API 接口
 * @param exclude 需要排除的 API 类型
 * @returns 随机选择的 API 类型
 */
export function selectRandomAPI(exclude?: RealAPIType[]): RealAPIType {
  const availableAPIs: Array<RealAPIType> = ["web", "webHTML", "mobile", "userHTML"];
  if (exclude && exclude.length > 0) {
    for (const api of exclude) {
      const index = availableAPIs.indexOf(api);
      if (index !== -1) {
        availableAPIs.splice(index, 1);
      }
    }
  }
  const randomIndex = Math.floor(Math.random() * availableAPIs.length);
  return availableAPIs[randomIndex];
}

let nonceCache: {
  startTimestamp: number;
  nonce: string;
} | undefined;

/**
 * 获取 nonce（6小时缓存）
 */
export async function getNonce(url: string): Promise<string | undefined> {
  const now = new Date().getTime();
  // 缓存6小时
  if (nonceCache?.startTimestamp && now - nonceCache.startTimestamp < 6 * 60 * 60 * 1000) {
    return nonceCache.nonce;
  }
  const resp = await doFetch(url);
  const setCookies = getSetCookieHeaders(resp);
  if (setCookies.length === 0) {
    throw new Error("No cookie in response");
  }
  const cookies: Record<string, string> = {};
  setCookies.forEach((cookie: string) => {
    const [key, _] = cookie.split(";");
    const [keyPart, valuePart] = key.split("=");
    if (!keyPart || !valuePart) return;
    cookies[keyPart.trim()] = valuePart.trim();
  });
  const nonce = cookies["__ac_nonce"];
  if (nonce) {
    nonceCache = {
      startTimestamp: now,
      nonce: nonce,
    };
  }
  return nonce;
}

// ============================================================================
// URL 解析与用户解析
// ============================================================================

/**
 * 从抖音短链接解析得到直播间ID
 * @param shortURL 短链接，如 https://v.douyin.com/DpfoBLAXoHM/
 * @returns webRoomId 直播间ID
 */
export async function resolveShortURL(shortURL: string): Promise<string> {
  // 获取跳转后的页面内容
  const resp = await doFetch(shortURL);
  // undici fetch 的 resp.url 即为重定向后的最终 URL（替代 axios 的 response.request.res.responseUrl）
  const redirectedURL = resp.url;
  if (redirectedURL.includes("/user/")) {
    const secUid = new URL(redirectedURL).searchParams.get("sec_uid");
    if (!secUid) {
      throw new Error("无法从短链接解析出直播间ID");
    }
    const uniqueId = await parseUser(`https://www.douyin.com/user/${secUid}`);
    if (!uniqueId) {
      throw new Error("无法从短链接解析出直播间ID");
    }
    return uniqueId;
  }

  // 尝试从页面内容中提取webRid
  const data = await resp.text();
  const webRidMatch = data.match(/"webRid\\":\\"(\d+)\\"/);
  if (webRidMatch) {
    return webRidMatch[1];
  }

  throw new Error("无法从短链接解析出直播间ID");
}

/**
 * 解析抖音用户主页获取 uniqueId（即 webRid）
 * @param url 抖音用户主页 URL
 */
export async function parseUser(url: string): Promise<string | null> {
  const timestamp = Math.floor(Date.now() / 1000);
  const ua = EDGE_UA;
  const nonce = (await getNonce(url)) ?? generateNonce();
  const signed = get__ac_signature(timestamp, url, nonce, ua);

  const resp = await doFetch(url, {
    headers: {
      "User-Agent": ua,
      cookie: `__ac_nonce=${nonce}; __ac_signature=${signed}`,
    },
  });
  const text = await resp.text();
  const regex = /\\"uniqueId\\":\\"(.*?)\\"/;
  const match = text.match(regex);
  if (match && match[1]) {
    return match[1];
  }

  return null;
}

// ============================================================================
// 各 API 接口实现
// ============================================================================

/**
 * 通过解析用户 html 页面来获取房间数据（userHTML API）
 * @param secUserId 用户 sec_uid
 * @param opts 选项
 */
async function getRoomInfoByUserWeb(
  secUserId: string,
  opts: {
    auth?: string;
  } = {},
): Promise<RoomInfo> {
  const url = `https://www.douyin.com/user/${secUserId}`;
  const ua = EDGE_UA;
  let nonce = "068ea1c0100bb2c06590f";

  try {
    nonce = (await getNonce(url)) ?? nonce;
  } catch (error) {
    console.warn("获取nonce失败，使用默认值", error);
  }

  let cookies: string;
  if (opts.auth) {
    cookies = opts.auth;
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    const signed = get__ac_signature(timestamp, url, nonce, ua);
    cookies = `__ac_nonce=${nonce}; __ac_signature=${signed}; __ac_referer=__ac_blank`;
  }

  const resp = await doFetch(url, {
    headers: {
      "User-Agent": ua,
      cookie: cookies,
    },
  });
  const data = await resp.text();

  if (data.includes("验证码")) {
    throw new Error("需要验证码，请在浏览器中打开链接获取" + url);
  }
  if (!data.includes("抖音号")) {
    throw new Error("userHTML页面没有正常加载" + String(data));
  }
  if (!data.includes("直播中")) {
    return {
      living: false,
      isLiveRadio: false,
      nickname: "",
      sec_uid: "",
      avatar: "",
      api: "userHTML",
      room: null,
    };
  }

  const userRegex = /(\{\\"user\\":.*?)\]\\n"\]\)/;
  const userMatch = data.match(userRegex);

  if (!userMatch) {
    throw new Error("No match found in HTML");
  }
  let userJsonStr = userMatch[1];
  userJsonStr = userJsonStr
    .replace(/\\"/g, '"')
    .replace(/\\"/g, '"')
    .replace(/"\$\w+"/g, "null");

  try {
    const userData = JSON.parse(userJsonStr);
    const roomData = userData?.user?.user?.roomData;
    const streamUrl = roomData?.stream_url;

    let liveCoreSdkData: { live_core_sdk_data: any } | null = null;
    if (streamUrl) {
      liveCoreSdkData = { live_core_sdk_data: streamUrl.live_core_sdk_data };
      if (liveCoreSdkData?.live_core_sdk_data?.pull_data) {
        const flvPullUrl = streamUrl.flv_pull_url;
        let streamData: StreamData["data"] = {};
        for (const quality of [{ key: "or4", desc: "原画" }, ...qualityList]) {
          const flvUrls = Object.values(flvPullUrl) as string[];
          if (flvUrls.some((url) => url.includes(`${quality.key}`))) {
            const url = flvUrls.find((url) => url.includes(`${quality.key}`));
            const convertedQuality = quality.key === "or4" ? "origin" : quality.key;
            streamData[convertedQuality] = {
              // @ts-ignore - main 对象只包含 flv/hls，省略其他可选字段
              main: {
                flv: url!,
                hls: "",
              },
            };
          }
        }

        liveCoreSdkData.live_core_sdk_data.pull_data.stream_data = streamData;
      } else {
        liveCoreSdkData = null;
      }
    }

    return {
      living: userData?.user?.user?.roomData?.status === 2,
      isLiveRadio: roomData?.live_type_audio ?? false,
      nickname: userData?.user?.user?.nickname ?? "",
      sec_uid: userData?.user?.user?.secUid ?? "",
      avatar: userData?.user?.user?.avatar ?? "",
      api: "userHTML",
      room: {
        title: "",
        cover: "",
        id_str: userData?.user?.user?.roomIdStr,
        stream_url: liveCoreSdkData,
      },
    };
  } catch (e) {
    console.error("Failed to parse JSON:", e);
    throw e;
  }
}

/**
 * 通过解析直播 html 页面来获取房间数据（webHTML API）
 * @param webRoomId 直播间 webRid
 * @param opts 选项
 */
async function getRoomInfoByHtml(
  webRoomId: string,
  opts: {
    auth?: string;
  } = {},
): Promise<RoomInfo> {
  const url = `https://live.douyin.com/${webRoomId}`;
  const ua = EDGE_UA;
  const nonce = generateNonce();

  let cookies: string;
  if (opts.auth) {
    cookies = opts.auth;
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    const signed = get__ac_signature(timestamp, url, nonce, ua);
    cookies = `__ac_nonce=${nonce}; __ac_signature=${signed}; __ac_referer=__ac_blank`;
  }

  const resp = await doFetch(url, {
    headers: {
      "User-Agent": ua,
      cookie: cookies,
    },
  });
  const data = await resp.text();
  const regex = /(\{\\"state\\":.*?)\]\\n"\]\)/;
  const match = data.match(regex);

  if (!match) {
    throw new Error("No match found in HTML");
  }
  let jsonStr = match[1];
  jsonStr = jsonStr.replace(/\\"/g, '"');
  jsonStr = jsonStr.replace(/\\"/g, '"');
  try {
    const parsed = JSON.parse(jsonStr);
    const roomInfo = parsed.state.roomStore.roomInfo;
    const streamData = parsed.state.streamStore.streamData;
    const isLiveRadio = roomInfo.enter_mode == 1;
    return {
      living: roomInfo?.room?.status === 2 || isLiveRadio,
      isLiveRadio: isLiveRadio,
      nickname: roomInfo?.anchor?.nickname ?? "",
      sec_uid: roomInfo?.anchor?.sec_uid ?? "",
      avatar: roomInfo?.anchor?.avatar_thumb?.url_list?.[0] ?? "",
      api: "webHTML",
      room: {
        title: roomInfo?.room?.title ?? "",
        cover: roomInfo?.room?.cover?.url_list?.[0] ?? "",
        id_str: roomInfo?.room?.id_str ?? "",
        stream_url: roomInfo?.room?.stream_url?.pull_datas
          ? {
              pull_datas: roomInfo?.room?.stream_url?.pull_datas,
              live_core_sdk_data: {
                pull_data: {
                  options: { qualities: streamData.H264_streamData?.options?.qualities ?? [] },
                  stream_data: streamData.H264_streamData?.stream ?? {},
                },
              },
            }
          : null,
      },
    };
  } catch (e) {
    console.error("Failed to parse JSON:", e);
    throw e;
  }
}

/**
 * 通过 web API 获取房间数据（使用 ABogus 签名）
 * @param webRoomId 直播间 webRid
 * @param opts 选项
 */
async function getRoomInfoByWeb(
  webRoomId: string,
  opts: {
    auth?: string;
  } = {},
): Promise<RoomInfo> {
  let cookies: string;
  if (opts.auth) {
    cookies = opts.auth;
  } else {
    // 抖音的 'webcast/room/web/enter' api 会需要 ttwid 的 cookie，这个 cookie 是由这个请求的响应头设置的，
    // 所以在这里请求一次自动设置。
    cookies = await getCookie();
  }

  const params: Record<string, string | number | boolean> = {
    aid: 6383,
    live_id: 1,
    device_platform: "web",
    language: "zh-CN",
    enter_from: "web_live",
    cookie_enabled: "true",
    screen_width: 1920,
    screen_height: 1080,
    browser_language: "zh-CN",
    browser_platform: "MacIntel",
    browser_name: "Chrome",
    browser_version: "108.0.0.0",
    web_rid: webRoomId,
    "Room-Enter-User-Login-Ab": 0,
    is_need_double_stream: "false",
  };

  const abogus = new ABogus();
  const [query, _unused, ua] = abogus.generateAbogus(
    new URLSearchParams(params as Record<string, string>).toString(),
    "",
  );

  const resp = await doFetch(
    `https://live.douyin.com/webcast/room/web/enter/?${query}`,
    {
      headers: {
        cookie: cookies,
        "User-Agent": ua,
      },
    },
  );
  const respData = (await resp.json()) as EnterRoomApiResp;

  if (respData.status_code === 30003) {
    // 直播已结束
    return {
      living: false,
      isLiveRadio: false,
      nickname: "",
      sec_uid: "",
      avatar: "",
      api: "web",
      room: {
        title: "",
        cover: "",
        id_str: "",
        stream_url: null,
      },
    };
  }
  assert(
    respData.status_code === 0,
    `Unexpected resp, code ${respData.status_code}, msg ${JSON.stringify(respData.data)}, id ${webRoomId}, cookies: ${cookies}`,
  );

  const data = respData.data;
  const room = data?.data?.[0];

  return {
    living: data?.room_status === 0 || data?.room_status === 1,
    isLiveRadio: data?.room_status === 1,
    nickname: data?.user?.nickname ?? "",
    avatar: data?.user?.avatar_thumb?.url_list?.[0] ?? "",
    sec_uid: data?.user?.sec_uid ?? "",
    api: "web",
    room: {
      title: room?.title ?? "",
      cover: room?.cover?.url_list?.[0] ?? "",
      id_str: room?.id_str ?? "",
      stream_url: room?.stream_url,
    },
  };
}

/**
 * 通过 mobile API 获取房间数据
 * @param secUserId 用户 sec_uid
 * @param opts 选项
 */
async function getRoomInfoByMobile(
  secUserId: string | number,
  opts: {
    auth?: string;
  } = {},
): Promise<RoomInfo> {
  if (!secUserId) {
    console.error(opts);
    throw new Error("Mobile API need secUserId, please set uid field");
  }
  if (typeof secUserId === "number") {
    throw new Error("Mobile API need secUserId string, please set uid field");
  }
  const params: Record<string, string | number> = {
    app_id: 1128,
    live_id: 1,
    verifyFp: "",
    room_id: 2,
    type_id: 0,
    sec_user_id: secUserId,
  };

  const queryString = new URLSearchParams(
    params as Record<string, string>,
  ).toString();
  const resp = await doFetch(
    `https://webcast.amemv.com/webcast/room/reflow/info/?${queryString}`,
  );
  // mobile API 的响应结构与 web API 不同，使用 any 处理
  const respData = (await resp.json()) as any;
  const room = respData?.data?.room;
  return {
    living: room?.status === 2,
    isLiveRadio: room?.live_type_audio ?? false,
    nickname: room?.owner?.nickname,
    sec_uid: room?.owner?.sec_uid,
    avatar: room?.owner?.avatar_thumb?.url_list?.[0],
    api: "mobile",
    room: {
      title: room?.title,
      cover: room?.cover?.url_list?.[0],
      id_str: room?.id_str,
      stream_url: room?.stream_url,
    },
  };
}

// ============================================================================
// 统一入口：getRoomInfo
// ============================================================================

export interface GetRoomInfoResult {
  living: boolean;
  // 是否为直播电台
  isLiveRadio?: boolean;
  roomId: string;
  owner: string;
  title: string;
  streams: StreamProfile[];
  sources: SourceProfile[];
  avatar: string;
  cover: string;
  liveId: string;
  uid: string;
  api: RealAPIType;
}

/**
 * 获取房间信息（统一入口），解析流数据并返回 sources/streams
 * @param webRoomId 直播间 webRid
 * @param opts 选项（auth, doubleScreen, api, uid）
 */
export async function getRoomInfo(
  webRoomId: string,
  opts: {
    auth?: string;
    doubleScreen?: boolean;
    api?: APIType;
    uid?: string | number;
  } = {},
): Promise<GetRoomInfoResult> {
  let data: RoomInfo;
  let api = opts.api ?? "web";

  // 如果选择了 random，则随机选择一个可用的接口
  if (api === "random") {
    api = selectRandomAPI();
  }

  if (api === "mobile" || api === "userHTML") {
    // mobile 接口需要 sec_uid 参数，老数据可能没有，实现兼容
    if (!opts.uid || typeof opts.uid !== "string") {
      api = "web";
    }
  }
  if (api === "webHTML") {
    data = await getRoomInfoByHtml(webRoomId, opts);
  } else if (api === "mobile") {
    data = await getRoomInfoByMobile(opts.uid as string, opts);
  } else if (api === "userHTML") {
    data = await getRoomInfoByUserWeb(opts.uid as string, opts);
  } else {
    data = await getRoomInfoByWeb(webRoomId, opts);
  }

  const room = data.room;

  assert(room, `No room data, id ${webRoomId}`);

  if (!room?.stream_url) {
    return {
      living: data.living,
      isLiveRadio: data.isLiveRadio,
      roomId: webRoomId,
      owner: data.nickname,
      title: room?.title ?? data.nickname,
      streams: [],
      sources: [],
      avatar: data.avatar,
      cover: room?.cover ?? "",
      liveId: room?.id_str ?? "",
      uid: data.sec_uid,
      api: data.api,
    };
  }

  let qualities: QualityInfo[] = [];
  let stream_data: string | object = "";
  if (opts.doubleScreen && !isEmpty(room.stream_url.pull_datas)) {
    const pull_data = Object.values(room.stream_url.pull_datas)[0] ?? {
      options: {
        qualities: [],
      },
      stream_data: "",
    };
    // @ts-ignore
    qualities = pull_data.options.qualities;
    // @ts-ignore
    stream_data = pull_data.stream_data;
  }
  if (!stream_data) {
    qualities = room.stream_url.live_core_sdk_data.pull_data.options.qualities;
    stream_data = room.stream_url.live_core_sdk_data.pull_data.stream_data;
  }
  const streamData: StreamData["data"] =
    typeof stream_data === "string"
      ? (JSON.parse(stream_data) as StreamData).data
      : (stream_data as StreamData["data"]);

  const streams: StreamProfile[] = qualities.map((info: QualityInfo) => ({
    desc: info.name,
    key: info.sdk_key,
    bitRate: info.v_bit_rate,
  }));

  // 转换流数据结构
  const streamList: StreamInfo[] = Object.entries(streamData)
    .map(([quality, info]) => {
      const stream = info?.main;
      const name = qualityList.find((item) => item.key === quality)?.desc;
      return {
        quality: quality,
        name: name ?? "未知",
        flv: stream?.flv,
        hls: stream?.hls,
      };
    })
    .filter((stream) => stream.flv || stream.hls);

  const aoStream = streamList.find((stream) => stream.quality === "ao");
  if (!!aoStream) {
    // 真原画流是在ao流中拿到的
    streamList.push({
      quality: "real_origin",
      name: "真原画",
      flv: (aoStream?.flv ?? "").replace("&only_audio=1", ""),
      hls: (aoStream?.hls ?? "").replace("&only_audio=1", ""),
    });
  }
  streamList.sort((a, b) => {
    const aIndex = qualityList.findIndex((item) => item.key === a.quality);
    const bIndex = qualityList.findIndex((item) => item.key === b.quality);
    // 如果找不到对应的质量等级，将其排在最后
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  // 看起来抖音是自动切换 cdn 的，所以这里固定返回一个默认的 source。
  const sources: SourceProfile[] = [
    {
      name: "自动",
      streamMap: streamData,
      streams: streamList,
    },
  ];

  return {
    living: data.living,
    isLiveRadio: data.isLiveRadio,
    roomId: webRoomId,
    owner: data.nickname,
    title: room.title,
    streams,
    sources,
    avatar: data.avatar,
    cover: room.cover,
    liveId: room.id_str,
    uid: data.sec_uid,
    api: data.api,
  };
}

// ============================================================================
// 内部类型定义（API 响应结构）
// ============================================================================

interface EnterRoomApiResp {
  data: {
    data: [
      | undefined
      | {
          id_str: string;
          status: number;
          status_str: string;
          title: string;
          user_count_str: string;
          cover: {
            url_list: string[];
          };
          stream_url?: {
            flv_pull_url: PullURLMap;
            default_resolution: string;
            hls_pull_url_map: PullURLMap;
            hls_pull_url: string;
            stream_orientation: number;
            live_core_sdk_data: {
              pull_data: {
                options: {
                  default_quality: QualityInfo;
                  qualities: QualityInfo[];
                };
                stream_data: string;
              };
            };
            extra: {
              height: number;
              width: number;
              fps: number;
              max_bitrate: number;
              min_bitrate: number;
              default_bitrate: number;
              bitrate_adapt_strategy: number;
              anchor_interact_profile: number;
              audience_interact_profile: number;
              hardware_encode: boolean;
              video_profile: number;
              h265_enable: boolean;
              gop_sec: number;
              bframe_enable: boolean;
              roi: boolean;
              sw_roi: boolean;
              bytevc1_enable: boolean;
            };
            pull_datas: Record<
              string,
              {
                options: {
                  qualities: QualityInfo[];
                };
                stream_data: string;
              }
            >;
          };
          mosaic_status: number;
          mosaic_status_str: string;
          admin_user_ids: number[];
          admin_user_ids_str: string[];
          owner: UserInfo;
          room_auth: unknown;
          live_room_mode: number;
          stats: {
            total_user_desp: string;
            like_count: number;
            total_user_str: string;
            user_count_str: string;
          };
          has_commerce_goods: boolean;
          linker_map: {};
          linker_detail: unknown;
          room_view_stats: {
            is_hidden: boolean;
            display_short: string;
            display_middle: string;
            display_long: string;
            display_value: number;
            display_version: number;
            incremental: boolean;
            display_type: number;
            display_short_anchor: string;
            display_middle_anchor: string;
            display_long_anchor: string;
          };
          scene_type_info: unknown;
          toolbar_data: unknown;
          room_cart: unknown;
        },
    ];
    enter_room_id: string;
    extra?: {
      digg_color: string;
      pay_scores: string;
      is_official_channel: boolean;
      signature: string;
    };
    user: UserInfo;
    qrcode_url: string;
    enter_mode: number;
    room_status: number;
    partition_road_map?: unknown;
    similar_rooms: unknown[];
    shark_decision_conf: string;
    web_stream_url?: unknown;
  };
  extra: { now: number };
  status_code: number;
}

type PullURLMap = Record<string, string>;

interface UserInfo {
  id_str: string;
  sec_uid: string;
  nickname: string;
  avatar_thumb: {
    url_list: string[];
  };
  follow_info: { follow_status: number; follow_status_str: string };
}
