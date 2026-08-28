/**
 * SOOP (formerly AfreecaTV) 直播流解析逻辑
 * 完全移植自 streamget 的 SOOP 模块
 * https://github.com/ihmily/streamget/blob/main/streamget/platforms/soop/live_stream.py
 *
 * 关键实现细节 (与 streamget fetch_web_stream_data + fetch_stream_url 一致):
 * 1. 通过 get_station_status 获取主播昵称
 * 2. 调用 player_live_api (type='') 获取 RESULT / VIEWPRESET / TITLE / BNO
 * 3. 若 RESULT 不在 [0,1]，尝试登录后重试
 * 4. 若 VIEWPRESET 存在 (表示在直播):
 *    a. 调用 broad_stream_assign 获取 view_url
 *    b. 调用 player_live_api (type='aid') 获取 AID
 *    c. m3u8_url = view_url + '?aid=' + AID
 *    d. 解析 master m3u8 获取 play_url_list (各画质子流 URL)
 * 5. 根据画质从 play_url_list 选择对应的子流 URL 作为录制地址
 *
 * 重要: 不检测 geo_cc 地理位置限制 — 与 streamget 行为一致。
 */
import {
  fetchStationAvatar,
  fetchStreamUrl,
  fetchUserNick,
  loginSoop,
  selectQualityUrl,
} from "./api.js";
import { SoopQualityDesc, SoopQualityMappingBit } from "./types.js";

export interface SoopGetInfoResult {
  living: boolean;
  owner: string;
  title: string;
  roomId: string;
  avatar: string;
  cover: string;
  userId: string;
  bno: string;
}

export interface SoopStreamResult {
  url: string;
  name: string;
  quality: string;
  bitrate: number;
}

/**
 * 获取 SOOP 直播间完整信息
 *
 * 流程 (与 streamget fetch_web_stream_data 一致):
 * 1. 调用 get_station_status 获取主播昵称
 * 2. 调用 player_live_api 获取直播状态
 * 3. 若 RESULT 不在 [0,1]，尝试登录后重试
 * 4. 通过 VIEWPRESET 判断是否在直播
 */
export async function getInfo(
  bjId: string,
  opts: { cookie?: string; username?: string; password?: string } = {},
): Promise<SoopGetInfoResult> {
  // Step 1: 获取主播昵称
  let owner = bjId;
  try {
    owner = await fetchUserNick(bjId, opts.cookie);
  } catch (e) {
    console.warn(`[soop] 获取昵称失败, 使用 bjId: ${e instanceof Error ? e.message : e}`);
  }

  // Step 1.5: 获取主播头像 (SOOP 头像 CDN 规范拼接, 无需调用接口)
  // 规范: https://profile.img.sooplive.co.kr/LOGO/{前两字符}/{完整ID}/{完整ID}.jpg
  let avatar = "";
  try {
    avatar = fetchStationAvatar(bjId);
  } catch (e) {
    console.warn(`[soop] 获取头像失败: ${e instanceof Error ? e.message : e}`);
  }

  // Step 2: 调用 player_live_api 获取直播信息
  let streamResult;
  try {
    streamResult = await fetchStreamUrl(bjId, opts.cookie);
  } catch (e) {
    console.warn(`[soop] fetchStreamUrl 失败: ${e instanceof Error ? e.message : e}`);
    streamResult = {
      m3u8Url: null,
      playUrlList: [],
      title: "",
      broadNo: "",
      result: -1,
      isLive: false,
    };
  }

  // Step 3: 若 RESULT 不在 [0,1]，尝试登录后重试
  if (
    streamResult.result !== 0 &&
    streamResult.result !== 1 &&
    opts.username &&
    opts.password
  ) {
    console.log("[soop] RESULT 不在 [0,1], 尝试登录后重试...");
    try {
      const loginCookie = await loginSoop(opts.username, opts.password);
      const mergedCookie = [opts.cookie, loginCookie]
        .filter(Boolean)
        .join("; ")
        .trim();
      streamResult = await fetchStreamUrl(bjId, mergedCookie || undefined);
    } catch (e) {
      console.warn(`[soop] 登录后重试失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  return {
    living: streamResult.isLive,
    owner,
    title: streamResult.title || "",
    roomId: streamResult.broadNo || bjId,
    avatar,
    cover: "",
    userId: bjId,
    bno: streamResult.broadNo,
  };
}

/**
 * 获取流地址（对外主入口）
 *
 * 流程 (与 streamget fetch_web_stream_data + fetch_stream_url 一致):
 * 1. 调用 player_live_api 获取 RESULT / BNO / VIEWPRESET
 * 2. 若 RESULT 不在 [0,1]，尝试登录后重试
 * 3. 若 VIEWPRESET 存在 (在直播):
 *    a. 获取 CDN URL (broad_stream_assign)
 *    b. 获取 AID (player_live_api type='aid')
 *    c. 构建 m3u8_url
 *    d. 解析 master m3u8 获取 play_url_list
 * 4. 根据画质从 play_url_list 选择录制地址
 *    - 优先使用选中画质的子流 URL (与 streamget 一致)
 *    - 若解析失败则回退到 master m3u8 URL
 */
export async function getStream(opts: {
  bjId: string;
  quality?: string;
  cookie?: string;
  username?: string;
  password?: string;
}): Promise<SoopStreamResult> {
  const desiredQuality = opts.quality || "OD";
  const bjId = opts.bjId;

  // 调用 fetchStreamUrl 获取流地址
  let streamResult = await fetchStreamUrl(bjId, opts.cookie);

  // 若 RESULT 不在 [0,1]，尝试登录后重试
  if (
    streamResult.result !== 0 &&
    streamResult.result !== 1 &&
    opts.username &&
    opts.password
  ) {
    console.log("[soop] getStream: RESULT 不在 [0,1], 尝试登录...");
    try {
      const loginCookie = await loginSoop(opts.username, opts.password);
      const mergedCookie = [opts.cookie, loginCookie]
        .filter(Boolean)
        .join("; ")
        .trim();
      streamResult = await fetchStreamUrl(bjId, mergedCookie || undefined);
    } catch (e) {
      throw new Error(
        `SOOP 获取流地址失败（登录后仍失败）: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  if (!streamResult.m3u8Url) {
    if (streamResult.result !== 0 && streamResult.result !== 1) {
      throw new Error(
        `SOOP 获取流地址失败: RESULT=${streamResult.result}，可能需要登录或主播未开播`
      );
    }
    throw new Error("SOOP 主播未开播或无法获取流地址");
  }

  // 根据画质选择录制地址 (与 streamget get_stream_url 一致)
  // 优先使用 play_url_list 中选中画质的子流 URL
  let recordUrl = streamResult.m3u8Url;
  if (streamResult.playUrlList.length > 0) {
    const selectedUrl = selectQualityUrl(streamResult.playUrlList, desiredQuality);
    if (selectedUrl) {
      recordUrl = selectedUrl;
      console.log(`[soop] 选中画质 ${desiredQuality} 的子流 URL: ${recordUrl.slice(0, 80)}...`);
    }
  }

  const qualityDesc = SoopQualityDesc[desiredQuality] || desiredQuality;
  const bitrate = SoopQualityMappingBit[desiredQuality] || 0;

  return {
    url: recordUrl,
    name: qualityDesc,
    quality: desiredQuality,
    bitrate,
  };
}

/**
 * 一次性获取直播信息和流地址
 */
export async function getInfoAndStream(
  bjId: string,
  opts: { cookie?: string; quality?: string; username?: string; password?: string } = {},
): Promise<{ info: SoopGetInfoResult; stream: SoopStreamResult | null }> {
  const desiredQuality = opts.quality || "OD";
  const info = await getInfo(bjId, opts);

  let stream: SoopStreamResult | null = null;
  if (info.living) {
    try {
      stream = await getStream({
        bjId,
        quality: desiredQuality,
        cookie: opts.cookie,
        username: opts.username,
        password: opts.password,
      });
    } catch (e) {
      console.warn(
        `[soop] 流地址获取失败:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { info, stream };
}

/**
 * 获取 SOOP 用户直播状态
 */
export async function getUserLiveStatus(
  bjId: string,
  cookie?: string,
): Promise<{ name: string; living: boolean; userId: string }> {
  const info = await getInfo(bjId, { cookie });
  return {
    name: info.owner,
    living: info.living,
    userId: info.userId,
  };
}
