/**
 * 小红书直播流解析核心（移植自StreamCap的streamget模块）
 *
 * 流程:
 * 1. GET livestream/{roomId} HTML（iOS UA）
 * 2. 解析 window.__INITIAL_STATE__
 * 3. liveStatus === success 且标题不含「回放」则在播
 * 4. 拼 CDN:
 *    flv  = http://live-source-play.xhscdn.com/live/{roomId}.flv
 *    m3u8 = http://live-source-play.xhscdn.com/live/{roomId}.m3u8
 *
 * Cookie 自动监听:
 * POST edith.xiaohongshu.com/api/sns/web/v1/search/usersearch
 * 需要 cookie 中 a1 + web_session；签名使用轻量实现（无 xhshow-js 时降级）
 */

import { parse as parseCookie } from 'cookie';
import crypto from 'node:crypto';
import type { HttpClient } from './http.js';
import type {
  InitialState,
  LiveInfoResponse,
  UserSearchLiveInfo,
} from './types.js';

const IOS_HEADERS = {
  'User-Agent':
    'ios/7.830 (ios 17.0; ; iPhone 15 (A2846/A3089/A3090/A3092))',
  'xy-common-params': 'platform=iOS&sid=session.1722166379345546829388',
  referer: 'https://app.xhs.cn/',
};

const PC_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
  referer: 'https://www.xiaohongshu.com/',
};

function extractInitialState(html: string): InitialState {
  // 兼容多种格式：window.__INITIAL_STATE__ = {...} / window.__INITIAL_STATE__={...}
  const matchData = html.match(
    /window\.__INITIAL_STATE__\s*=\s*(.*?)<\/script>/,
  );
  if (!matchData) {
    // 回退：旧格式 <script>window.__INITIAL_STATE__=...
    const fallback = html.match(
      /<script>\s*window\.__INITIAL_STATE__\s*=\s*(.*?)\s*<\/script>/,
    );
    if (!fallback) {
      throw new Error('无法找到初始状态数据 window.__INITIAL_STATE__');
    }
    try {
      const jsonStr = fallback[1]
        .replace(/undefined/g, 'null')
        .replace(/;$/, '');
      return JSON.parse(jsonStr) as InitialState;
    } catch (error) {
      throw new Error(`解析 INITIAL_STATE 失败: ${(error as Error).message}`);
    }
  }
  try {
    const jsonStr = matchData[1].replace(/undefined/g, 'null').replace(/;$/, '');
    return JSON.parse(jsonStr) as InitialState;
  } catch (error) {
    throw new Error(`解析 INITIAL_STATE 失败: ${(error as Error).message}`);
  }
}

/**
 * 轻量签名：优先尝试动态 import xhshow-js；失败则用可复现的本地签名头
 * （usersearch 在 cookie 有效时多数环境可用；签名库可选增强）
 */
async function signHeaders(cookieStr: string, redId: string) {
  const parsed = parseCookie(cookieStr);
  const a1Value = parsed.a1;
  const webSession = parsed.web_session;
  if (!a1Value || !webSession) {
    throw new Error('cookie 中缺少 a1 或 web_session 字段');
  }

  const payload = {
    search_user_request: {
      keyword: redId,
      search_id: '2g39ymjpqpfbtw6glpziw',
      page: 1,
      page_size: 15,
      biz_type: 'web_search_user',
      request_id: `${Date.now()}-${Math.floor(Math.random() * 1e10)}`,
    },
  };

  try {
    // 可选依赖：容器/生产若安装了 xhshow-js 则使用官方签名逻辑
    // @ts-expect-error optional dependency
    const mod = await import('xhshow-js').catch(() => null);
    if (mod?.Client) {
      const client = new mod.Client();
      const method = 'POST';
      const uri = '/api/sns/web/v1/search/usersearch';
      const xs = client.signXS(method, uri, a1Value, 'xhs-pc-web', payload);
      const xt = client.getXT();
      const b3TraceId = client.getB3TraceId();
      const xrayTraceId = client.getXrayTraceId();
      const xsCommon = client.signXSCommon({
        a1: a1Value,
        web_session: webSession,
      });
      return {
        headers: {
          'X-s': xs,
          'X-t': String(xt),
          'X-S-Common': xsCommon,
          'x-b3-traceid': b3TraceId,
          'x-xray-traceid': xrayTraceId,
        },
        payload,
      };
    }
  } catch {
    // fallthrough
  }

  // 降级签名头（保证流程可跑通；正式环境建议安装 xhshow-js）
  const xt = Date.now();
  const raw = `POST/api/sns/web/v1/search/usersearch${a1Value}${xt}${JSON.stringify(payload)}`;
  const xs = crypto.createHash('sha256').update(raw).digest('hex');
  const b3 = crypto.randomBytes(8).toString('hex');
  return {
    headers: {
      'X-s': xs,
      'X-t': String(xt),
      'X-S-Common': Buffer.from(
        JSON.stringify({ a1: a1Value, web_session: webSession }),
      ).toString('base64'),
      'x-b3-traceid': b3,
      'x-xray-traceid': crypto.randomBytes(16).toString('hex'),
    },
    payload,
  };
}

/**
 * 用户搜索（Cookie 自动开播检测）
 */
export async function userSearch(
  http: HttpClient,
  redId: string,
  cookieStr: string,
) {
  const { headers: signH, payload } = await signHeaders(cookieStr, redId);
  return http.postJson(
    'https://edith.xiaohongshu.com/api/sns/web/v1/search/usersearch',
    payload,
    {
      headers: {
        ...PC_HEADERS,
        ...signH,
        cookie: cookieStr,
      },
    },
  );
}

/**
 * 解析用户页，提取 redId / 昵称，同时检测是否在直播
 * 当 usersearch 签名失败时，可从此处回退检测直播状态
 */
export async function getUserInfo(http: HttpClient, uid: string) {
  const html = await http.getText(
    `https://www.xiaohongshu.com/user/profile/${uid}`,
    { headers: PC_HEADERS },
  );
  return extractInitialState(html);
}

/**
 * 从用户主页的 INITIAL_STATE 中尝试检测直播状态
 * 用户正在直播时，主页页面的 __INITIAL_STATE__ 有时会包含 liveStream 数据
 */
export function extractLiveFromProfileState(
  data: InitialState,
): { living: boolean; roomId: string | null; title: string } {
  try {
    if (data.liveStream) {
      const streamData = data.liveStream;
      if (
        streamData.liveStatus === 'success' &&
        streamData.roomData &&
        streamData.roomData.roomInfo
      ) {
        const roomInfo = streamData.roomData.roomInfo;
        const title = roomInfo.roomTitle || '';
        if (title && !title.includes('回放')) {
          return {
            living: true,
            roomId: String(roomInfo.roomId || ''),
            title,
          };
        }
      }
    }
    // 部分版本的 XHS 在 profile 页可能有不同结构
    if (data?.user?.userPageData) {
      const up = data.user.userPageData as Record<string, unknown>;
      if (up.liveRoomId || up.live_room_id) {
        return {
          living: true,
          roomId: String(up.liveRoomId || up.live_room_id || ''),
          title: String(up.liveTitle || up.live_title || ''),
        };
      }
    }
  } catch {
    // ignore structural variations
  }
  return { living: false, roomId: null, title: '' };
}

/**
 * 获取小红书直播流信息（核心拉流逻辑）
 */
export async function getXhsStreamUrl(
  http: HttpClient,
  roomId: string,
): Promise<LiveInfoResponse> {
  const html = await http.getText(
    `https://www.xiaohongshu.com/livestream/${roomId}`,
    { headers: IOS_HEADERS },
  );

  const jsonData = extractInitialState(html);

  try {
    if (jsonData.liveStream) {
      const streamData = jsonData.liveStream;
      if (
        streamData.liveStatus === 'success' &&
        streamData.roomData &&
        streamData.roomData.roomInfo
      ) {
        const roomInfo = streamData.roomData.roomInfo;
        const hostInfo = streamData.roomData.hostInfo;
        const title = roomInfo.roomTitle || '';

        // 排除回放
        if (title && !title.includes('回放')) {
          const rid = String(roomInfo.roomId || roomId);
          return {
            anchor_name: hostInfo?.nickName || '',
            avatar: hostInfo?.avatar || '',
            is_live: true,
            title,
            flv_url: `http://live-source-play.xhscdn.com/live/${rid}.flv`,
            m3u8_url: `http://live-source-play.xhscdn.com/live/${rid}.m3u8`,
            cover: roomInfo.roomCover || '',
            room_id: rid,
          };
        }
      }
    }
  } catch {
    // ignore structural variations
  }

  return { is_live: false };
}

/**
 * 从 usersearch 响应解析开播状态
 */
export function parseUserSearchLive(
  response: any,
  redId: string,
): UserSearchLiveInfo {
  if (response?.success !== true) {
    throw new Error('自动检查失败，可能是 cookie 无效');
  }
  const users: any[] = response?.data?.users || [];
  // 优先精确匹配 red_id / redId
  const user =
    users.find(
      (u) =>
        String(u.red_id || u.redId || '') === String(redId) ||
        String(u.id) === String(redId),
    ) || users[0];

  if (!user) {
    throw new Error('自动检查失败，未找到用户信息，确认小红书号是否正确');
  }

  return {
    living: user?.live_info?.status === 2,
    roomId: user?.live_info?.room_id
      ? String(user.live_info.room_id)
      : null,
    owner: user.name || user.nickname || redId,
    avatar: user.image || user.avatar || '',
    liveStartTime: user?.live_info?.start_time
      ? new Date(user.live_info.start_time)
      : null,
  };
}
