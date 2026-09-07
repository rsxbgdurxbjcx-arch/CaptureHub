/**
 * 快手直播 API 层
 * 移植自 streamget (https://github.com/ihmily/streamget) 的快手模块
 * 将 Python aiohttp 替换为 undici，适配 red 项目
 */
import { fetch as undiciFetch } from "undici";
import { assert } from "../utils.js";
import type { KsUserInfoResp } from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0";

/**
 * 快手 PC 端请求头（与 streamget 完全一致）
 * 注意：不含 cookie，cookie 仅在需要时通过参数追加
 */
export const KS_HEADERS: Record<string, string> = {
  "user-agent": DEFAULT_UA,
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  "referer": "https://live.kuaishou.com/profile/cym030000",
};

async function doFetch(
  url: string,
  options: { headers?: Record<string, string>; timeout?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = options.timeout ?? 15000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return (await undiciFetch(url, {
      method: "GET",
      headers: { ...KS_HEADERS, ...options.headers },
      signal: controller.signal,
      redirect: "follow" as const,
    } as any)) as Response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 获取快手用户信息（直播状态 + 用户名）
 * API: https://live.kuaishou.com/live_api/baseuser/userinfo/byid
 * 必须传入 Cookie，否则无法获取用户信息
 *
 * 实际 API 响应字段：
 *   data.result         — 状态码 (1=正常, 2=风控, 21=用户不存在/封禁)
 *   data.userInfo.id    — 用户 ID
 *   data.userInfo.name  — 用户名
 *   data.userInfo.living — 是否在直播
 *   data.userInfo.avatar — 头像 URL
 */
export async function getUserInfo(
  uid: string,
  cookie?: string,
): Promise<{ name: string; living: boolean; userId: string; avatar: string }> {
  const api = `https://live.kuaishou.com/live_api/baseuser/userinfo/byid?__NS_hxfalcon=&caver=2&principalId=${uid}`;
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;

  const resp = await doFetch(api, { headers });
  const data = (await resp.json()) as KsUserInfoResp;
  const result = data.data?.result;
  const userInfo = data.data?.userInfo;

  assert(userInfo, "快手用户信息 API 返回异常");

  if (result === 2 && userInfo.name) {
    throw new Error("快手账号异常，触发风控");
  }

  return {
    name: userInfo.name || "",
    living: !!userInfo.living,
    userId: userInfo.id || uid,
    avatar: userInfo.avatar || "",
  };
}

/**
 * 获取快手直播间页面 HTML
 * 用于提取 __INITIAL_STATE__ 中的直播流数据
 *
 * @param url     直播间 URL
 * @param cookie  可选 Cookie（传入时可获取更完整的页面数据）
 */
export async function fetchLivePage(
  url: string,
  cookie?: string,
): Promise<string> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  const resp = await doFetch(url, { headers });
  return await resp.text();
}
