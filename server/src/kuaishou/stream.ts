/**
 * 快手直播流解析逻辑
 * 移植自 streamget (https://github.com/ihmily/streamget) 的 KwaiLiveStream
 *
 * 关键实现细节：
 * 1. Cookie 用于 API 状态检测和 HTML 页面请求
 * 2. 即使 API 返回 living=false，也仍然请求 HTML 页面验证（API 可能不可靠）
 * 3. __INITIAL_STATE__ 先尝试完整 JSON 解析（清理 undefined），再回退到正则提取
 * 4. liveStream 数据位于 liveroom.playList[0]，使用递归查找作为兜底
 * 5. 直播状态以 liveStream.playUrls 为准（author.living 不可靠）
 */
import { assert } from "../utils.js";
import { fetchLivePage, getUserInfo } from "./api.js";
import { QualityMappingBit, KsQualityDesc } from "./types.js";
import type {
  KsPlayList,
  KsRepresentation,
  KsPlayUrls,
} from "./types.js";

export interface KsGetInfoResult {
  living: boolean;
  owner: string;
  title: string;
  roomId: string;
  avatar: string;
  cover: string;
  userId: string;
  liveId: string;
}

/**
 * 从 HTML 中提取 __INITIAL_STATE__ JSON 字符串
 *
 * 快手直播页面格式（与 streamget 完全一致）：
 *   <script>window.__INITIAL_STATE__={...};(function(){var s;
 */
function extractInitialStateJson(html: string): string | null {
  // 方式1：streamget 精确正则（首选）
  const match = html.match(
    /<script>window\.__INITIAL_STATE__=([\s\S]*?);\(function\(\)\{var s;/,
  );
  if (match) return match[1];

  // 方式2：回退 — 匹配 window.__INITIAL_STATE__={...}; 的通用形式
  const match2 = html.match(
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/,
  );
  if (match2) return match2[1];

  // 方式3：回退 — 匹配 window["__INITIAL_STATE__"]={...};
  const match3 = html.match(
    /window\["__INITIAL_STATE__"\]\s*=\s*(\{[\s\S]*?\});/,
  );
  if (match3) return match3[1];

  return null;
}

/**
 * 递归查找包含 liveStream 属性的对象
 */
function deepFindPlayList(obj: unknown): KsPlayList | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  // 检查当前对象是否包含 liveStream
  if (o.liveStream && typeof o.liveStream === "object") {
    return o as unknown as KsPlayList;
  }

  // 递归搜索子对象
  for (const key of Object.keys(o)) {
    const val = o[key];
    if (val && typeof val === "object") {
      // 如果是数组，搜索每个元素
      if (Array.isArray(val)) {
        for (const item of val) {
          const result = deepFindPlayList(item);
          if (result) return result;
        }
      } else {
        const result = deepFindPlayList(val);
        if (result) return result;
      }
    }
  }
  return null;
}

/**
 * 从 __INITIAL_STATE__ JSON 字符串中提取 playList 对象
 *
 * 策略1（首选）：完整 JSON 解析 + 路径导航
 *   - 清理 undefined → null（快手页面包含 JS undefined，不是合法 JSON）
 *   - 解析完整 JSON
 *   - 导航到 liveroom.playList[0]
 *   - 回退到递归查找 liveStream
 *
 * 策略2（兜底）：正则提取（与 streamget 一致）
 *   - 匹配 {"liveStream"...},"gameInfo" 模式
 */
function extractPlayList(jsonStr: string): KsPlayList | null {
  // === 策略1：完整 JSON 解析 ===
  try {
    // 快手页面的 __INITIAL_STATE__ 包含 JavaScript undefined 值
    // 需要替换为 null 才能用 JSON.parse 解析
    const cleaned = jsonStr.replace(/:\s*undefined/g, ":null");
    const fullJson = JSON.parse(cleaned) as Record<string, unknown>;

    // 尝试导航到 liveroom.playList[0]
    const liveroom = fullJson.liveroom as
      | { playList?: unknown[] }
      | undefined;
    if (liveroom?.playList && Array.isArray(liveroom.playList)) {
      for (const item of liveroom.playList) {
        const playList = deepFindPlayList(item);
        if (playList?.liveStream) {
          return playList;
        }
      }
    }

    // 回退：递归查找 liveStream
    const found = deepFindPlayList(fullJson);
    if (found?.liveStream) {
      return found;
    }
  } catch {
    // 完整解析失败，尝试正则方式
  }

  // === 策略2：正则提取（streamget 方式） ===
  const match = jsonStr.match(/(\{"liveStream"[\s\S]*?),"gameInfo/);
  if (match) {
    const playListStr = match[1] + "}";
    try {
      return JSON.parse(playListStr) as KsPlayList;
    } catch {
      try {
        const cleaned = playListStr
          .replace(/\\u002f/gi, "/")
          .replace(/\\u0026/gi, "&")
          .replace(/:\s*undefined/g, ":null");
        return JSON.parse(cleaned) as KsPlayList;
      } catch {
        // 继续尝试
      }
    }
  }

  // 方式3：匹配 {"liveStream" 到下一个 ,"gameInfo" 或 ,"liveStream"
  const match2 = jsonStr.match(
    /(\{"liveStream"[\s\S]*?)(?:,"gameInfo|,"liveStream")/,
  );
  if (match2) {
    const playListStr = match2[1] + "}";
    try {
      return JSON.parse(playListStr) as KsPlayList;
    } catch {
      try {
        const cleaned = playListStr
          .replace(/\\u002f/gi, "/")
          .replace(/\\u0026/gi, "&")
          .replace(/:\s*undefined/g, ":null");
        return JSON.parse(cleaned) as KsPlayList;
      } catch {
        // give up
      }
    }
  }

  return null;
}

/**
 * 从 playUrls 中提取所有 representation（跨所有编码格式）
 *
 * 关键修复：不再只取 h264，而是收集 h264/hevc/av1 等所有编码格式的
 * 全部 representation，确保能选到最高分辨率/最高码率的流。
 * 快手高画质（蓝光/4K）通常仅通过 HEVC 提供。
 */
function getRepresentations(playUrls: KsPlayUrls): KsRepresentation[] {
  const all: KsRepresentation[] = [];

  for (const codecKey of Object.keys(playUrls)) {
    // 跳过非编码格式的 key
    if (codecKey === "errorType") continue;
    const pu = (playUrls as Record<string, unknown>)[codecKey] as {
      adaptationSet?: { representation?: KsRepresentation[] };
    };
    const reps = pu?.adaptationSet?.representation;
    if (reps && Array.isArray(reps) && reps.length > 0) {
      // 标注编码格式
      for (const r of reps) {
        all.push({ ...r, codec: codecKey });
      }
    }
  }

  return all;
}

/**
 * 获取快手直播间完整信息
 *
 * 流程：
 * 1. 如果有 cookie，先通过 API 获取用户名和直播状态（用于补充信息）
 * 2. 请求 HTML 页面（携带 cookie 以获取更完整的数据），从中提取直播流数据
 * 3. 直播状态以 HTML 页面中的 liveStream.playUrls 为准
 *
 * 重要：即使 API 返回 living=false，也仍然请求 HTML 页面验证。
 * 因为 API 可能因 cookie 过期、IP 限制等原因返回错误的状态。
 */
export async function getInfo(
  eid: string,
  opts: { cookie?: string } = {},
): Promise<KsGetInfoResult> {
  const liveUrl = eid.startsWith("http")
    ? eid
    : `https://live.kuaishou.com/u/${eid}`;

  let apiName = "";
  let apiAvatar = "";
  let apiLiving = false;

  // 步骤1：如果有 cookie，通过 API 获取用户名和直播状态
  if (opts.cookie && opts.cookie.trim() !== "") {
    try {
      const userInfo = await getUserInfo(eid, opts.cookie);
      apiName = userInfo.name;
      apiAvatar = userInfo.avatar;
      apiLiving = userInfo.living;
      console.log(`[kuaishou] API 检测: ${apiName} living=${apiLiving}`);
    } catch (e) {
      console.warn(
        `[kuaishou] API 状态检测失败，将依赖 HTML 页面解析:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // 步骤2：请求 HTML 页面（携带 cookie 以获取更完整的数据）
  const html = await fetchLivePage(liveUrl, opts.cookie);

  // 步骤3：提取 __INITIAL_STATE__ JSON 字符串
  const jsonStr = extractInitialStateJson(html);
  if (!jsonStr) {
    if (apiLiving) {
      throw new Error(
        `无法从快手页面提取 __INITIAL_STATE__ (API 显示在播但页面解析失败)`,
      );
    }
    console.warn(
      `[kuaishou] 无法提取 __INITIAL_STATE__，HTML 长度: ${html.length}`,
    );
    return {
      living: false,
      owner: apiName,
      title: "",
      roomId: eid,
      avatar: apiAvatar,
      cover: "",
      userId: eid,
      liveId: eid,
    };
  }

  // 步骤4：提取 playList
  const playList = extractPlayList(jsonStr);
  if (!playList) {
    if (apiLiving) {
      throw new Error(`无法从 __INITIAL_STATE__ 提取直播流数据`);
    }
    console.warn(`[kuaishou] 无法提取 playList`);
    return {
      living: false,
      owner: apiName,
      title: "",
      roomId: eid,
      avatar: apiAvatar,
      cover: "",
      userId: eid,
      liveId: eid,
    };
  }

  // 检查错误类型
  const errorType = (
    playList as { errorType?: { title?: string; content?: string } }
  ).errorType;
  if (errorType?.content) {
    console.warn(
      `[kuaishou] errorType: ${errorType.title} - ${errorType.content}`,
    );
    return {
      living: false,
      owner: apiName || playList.author?.name || "",
      title: "",
      roomId: eid,
      avatar: apiAvatar || playList.author?.avatar || "",
      cover: "",
      userId: eid,
      liveId: eid,
    };
  }

  // 检查 liveStream 是否存在
  const liveStream = playList.liveStream;
  if (!liveStream) {
    return {
      living: false,
      owner: apiName || playList.author?.name || "",
      title: "",
      roomId: eid,
      avatar: apiAvatar || playList.author?.avatar || "",
      cover: "",
      userId: eid,
      liveId: eid,
    };
  }

  const author = playList.author;

  // 检测直播状态：有 playUrls 且有 representation 即在播
  const living = !!(
    liveStream.playUrls &&
    getRepresentations(liveStream.playUrls).length > 0
  );

  if (living && !apiLiving) {
    console.log(`[kuaishou] HTML 检测到在播 (API 未检测到，以 HTML 为准)`);
  }

  return {
    living: living || apiLiving,
    owner: author?.name || apiName || "",
    title: "",
    roomId: liveStream.id || eid,
    avatar: author?.avatar || apiAvatar || "",
    cover: liveStream.poster || "",
    userId: author?.id || eid,
    liveId: liveStream.id || eid,
  };
}

export interface KsStreamResult {
  url: string;
  name: string;
  quality: string;
  bitrate: number;
}

/**
 * 从 playList 中提取最高画质流地址
 *
 * 质量选择策略（始终选最高画质）：
 * 1. 收集所有编码格式（h264/hevc/av1）的全部 representation
 * 2. 按综合质量评分排序：分辨率(像素总数) → 码率 → 帧率
 * 3. OD(原画) 模式直接选评分最高的流
 * 4. 非 OD 模式按目标码率匹配，找不到则选最高
 */
function extractStreamFromPlayList(
  playList: KsPlayList,
  desiredQuality: string,
): KsStreamResult {
  const errorType = (
    playList as { errorType?: { title?: string; content?: string } }
  ).errorType;
  if (errorType?.content) {
    throw new Error(
      `快手直播解析错误: ${errorType.title} - ${errorType.content}`,
    );
  }

  assert(playList.liveStream?.playUrls, "直播未开始或无法获取流地址");

  const representations = getRepresentations(playList.liveStream.playUrls);
  assert(representations.length > 0, "没有可用的流地址");

  // 综合质量评分：分辨率(像素总数) * 1000 + 码率
  // 分辨率优先级最高，同分辨率下按码率排序
  function qualityScore(r: KsRepresentation): number {
    const pixels = (r.width || 0) * (r.height || 0);
    const bitrate = r.bitrate || 0;
    const fps = r.frameRate || 0;
    // 分辨率权重最高，其次码率，最后帧率
    return pixels * 10000 + bitrate * 10 + fps;
  }

  // 按综合质量评分从高到低排序
  const sorted = [...representations].sort(
    (a, b) => qualityScore(b) - qualityScore(a),
  );

  // 打印所有可用画质（用于调试）
  console.log(
    `[kuaishou] 可用画质 ${sorted.length} 条:`,
    sorted.map((r) => ({
      codec: r.codec,
      quality: r.qualityType,
      name: r.name || r.shortName,
      bitrate: r.bitrate,
      res: r.width && r.height ? `${r.width}x${r.height}` : "?",
      fps: r.frameRate || "?",
    })),
  );

  // 尝试匹配期望画质
  const desiredBitrate = QualityMappingBit[desiredQuality] || 99999;

  let best: KsRepresentation | undefined;
  if (desiredQuality === "OD") {
    // 原画模式：直接选综合评分最高的流
    best = sorted[0];
    console.log(
      `[kuaishou] 选定原画画质: ${best.codec} ${best.width || "?"}x${best.height || "?"} ` +
      `${best.bitrate || "?"}kbps ${best.frameRate || "?"}fps`,
    );
  } else {
    // 非 OD 模式：按目标码率匹配（不超过目标码率的最大值）
    best = sorted.find((r) => (r.bitrate || 0) <= desiredBitrate);
    if (!best) best = sorted[0];
    console.log(
      `[kuaishou] 选定画质 ${desiredQuality}: ${best.codec} ${best.width || "?"}x${best.height || "?"} ` +
      `${best.bitrate || "?"}kbps ${best.frameRate || "?"}fps`,
    );
  }

  assert(best?.url, "无法获取流地址");

  const qualityName = best.qualityType || desiredQuality;
  const qualityDesc = best.name || best.shortName || KsQualityDesc[qualityName] || qualityName;
  const resDesc = best.width && best.height ? ` ${best.width}x${best.height}` : "";
  const codecDesc = best.codec ? ` [${best.codec.toUpperCase()}]` : "";

  return {
    url: best.url,
    name: `${qualityDesc}${resDesc}${codecDesc}`,
    quality: qualityName,
    bitrate: best.bitrate || 0,
  };
}

/**
 * 一次性获取直播信息和流地址（只请求一次 HTML 页面）
 * 避免 getInfo + getStream 分别请求页面导致的限流问题
 */
export async function getInfoAndStream(
  eid: string,
  opts: { cookie?: string; quality?: string } = {},
): Promise<{ info: KsGetInfoResult; stream: KsStreamResult | null }> {
  const desiredQuality = opts.quality || "OD";
  const liveUrl = eid.startsWith("http")
    ? eid
    : `https://live.kuaishou.com/u/${eid}`;

  let apiName = "";
  let apiAvatar = "";
  let apiLiving = false;

  // 步骤1：如果有 cookie，通过 API 获取用户名和直播状态
  if (opts.cookie && opts.cookie.trim() !== "") {
    try {
      const userInfo = await getUserInfo(eid, opts.cookie);
      apiName = userInfo.name;
      apiAvatar = userInfo.avatar;
      apiLiving = userInfo.living;
      console.log(`[kuaishou] API 检测: ${apiName} living=${apiLiving}`);
    } catch (e) {
      console.warn(
        `[kuaishou] API 状态检测失败，将依赖 HTML 页面解析:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // 步骤2：请求 HTML 页面（只请求一次！）
  const html = await fetchLivePage(liveUrl, opts.cookie);

  // 步骤3：提取 __INITIAL_STATE__ JSON 字符串
  const jsonStr = extractInitialStateJson(html);
  if (!jsonStr) {
    if (apiLiving) {
      throw new Error(
        `无法从快手页面提取 __INITIAL_STATE__ (API 显示在播但页面解析失败)`,
      );
    }
    console.warn(
      `[kuaishou] 无法提取 __INITIAL_STATE__，HTML 长度: ${html.length}`,
    );
    return {
      info: {
        living: false,
        owner: apiName,
        title: "",
        roomId: eid,
        avatar: apiAvatar,
        cover: "",
        userId: eid,
        liveId: eid,
      },
      stream: null,
    };
  }

  // 步骤4：提取 playList
  const playList = extractPlayList(jsonStr);
  if (!playList) {
    if (apiLiving) {
      throw new Error(`无法从 __INITIAL_STATE__ 提取直播流数据`);
    }
    console.warn(`[kuaishou] 无法提取 playList`);
    return {
      info: {
        living: false,
        owner: apiName,
        title: "",
        roomId: eid,
        avatar: apiAvatar,
        cover: "",
        userId: eid,
        liveId: eid,
      },
      stream: null,
    };
  }

  // 检查错误类型
  const errorType = (
    playList as { errorType?: { title?: string; content?: string } }
  ).errorType;
  if (errorType?.content) {
    console.warn(
      `[kuaishou] errorType: ${errorType.title} - ${errorType.content}`,
    );
    return {
      info: {
        living: false,
        owner: apiName || playList.author?.name || "",
        title: "",
        roomId: eid,
        avatar: apiAvatar || playList.author?.avatar || "",
        cover: "",
        userId: eid,
        liveId: eid,
      },
      stream: null,
    };
  }

  // 检查 liveStream 是否存在
  const liveStream = playList.liveStream;
  if (!liveStream) {
    return {
      info: {
        living: false,
        owner: apiName || playList.author?.name || "",
        title: "",
        roomId: eid,
        avatar: apiAvatar || playList.author?.avatar || "",
        cover: "",
        userId: eid,
        liveId: eid,
      },
      stream: null,
    };
  }

  const author = playList.author;

  // 检测直播状态：有 playUrls 且有 representation 即在播
  const living = !!(
    liveStream.playUrls &&
    getRepresentations(liveStream.playUrls).length > 0
  );

  if (living && !apiLiving) {
    console.log(`[kuaishou] HTML 检测到在播 (API 未检测到，以 HTML 为准)`);
  }

  const info: KsGetInfoResult = {
    living: living || apiLiving,
    owner: author?.name || apiName || "",
    title: "",
    roomId: liveStream.id || eid,
    avatar: author?.avatar || apiAvatar || "",
    cover: liveStream.poster || "",
    userId: author?.id || eid,
    liveId: liveStream.id || eid,
  };

  // 如果在播，从同一个 playList 提取流地址（不重复请求页面）
  let stream: KsStreamResult | null = null;
  if (info.living && liveStream.playUrls) {
    try {
      stream = extractStreamFromPlayList(playList, desiredQuality);
    } catch (e) {
      console.warn(
        `[kuaishou] 流地址提取失败:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { info, stream };
}

/**
 * 获取流地址（对外主入口）
 * 默认请求最高画质（OD=原画），画质不匹配时自动降级
 *
 * 注意：此函数会单独请求 HTML 页面。
 * 如果已经通过 getInfo 获取了页面数据，建议使用 getInfoAndStream 避免重复请求。
 */
export async function getStream(opts: {
  eid: string;
  quality?: string;
  cookie?: string;
}): Promise<KsStreamResult> {
  const desiredQuality = opts.quality || "OD";

  const liveUrl = opts.eid.startsWith("http")
    ? opts.eid
    : `https://live.kuaishou.com/u/${opts.eid}`;

  const html = await fetchLivePage(liveUrl, opts.cookie);

  const jsonStr = extractInitialStateJson(html);
  assert(jsonStr, "无法从快手页面提取 __INITIAL_STATE__");

  const playList = extractPlayList(jsonStr);
  assert(playList, "无法从 __INITIAL_STATE__ 提取直播流数据");

  return extractStreamFromPlayList(playList, desiredQuality);
}

/**
 * 获取快手用户直播状态（通过 API）
 */
export async function getUserLiveStatus(
  uid: string,
  cookie?: string,
): Promise<{ name: string; living: boolean; userId: string }> {
  return getUserInfo(uid, cookie);
}
