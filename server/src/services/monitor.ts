import { loadSettings } from '../config.js';
import { streamerRepo } from '../db/index.js';
import type { Streamer, Platform } from '../types.js';
import { nowIso } from '../utils.js';
import { XhsParser } from '../xhs/parser.js';
import { DouyinParser } from '../douyin/parser.js';
import { BilibiliParser } from '../bilibili/parser.js';
import { KuaishouParser } from '../kuaishou/parser.js';
import { SoopParser } from '../soop/parser.js';
import { PandaliveParser } from '../pandalive/parser.js';
import { StripchatParser } from '../stripchat/index.js';
import { getInfo as getStripchatInfo } from '../stripchat/stream.js';
import { getMouflonKeys } from '../stripchat/mouflon.js';
import { recorderService } from './recorder.js';

/**
 * 循环监控主播开播状态并自动开录
 * 支持小红书(xhs)、抖音(douyin)、哔哩哔哩(bilibili)、快手(kuaishou)、
 * SOOP(soop)、Pandalive(pandalive)、Stripchat(stripchat) 七平台
 */
export class MonitorService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private startedAt = Date.now();

  start() {
    if (this.timer) return;
    const settings = loadSettings();
    const interval = Math.max(5, settings.pollIntervalSec) * 1000;
    console.log(`[monitor] start poll every ${interval / 1000}s`);
    this.timer = setInterval(() => void this.tick(), interval);
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  restart() {
    this.stop();
    this.start();
  }

  getUptimeSec() {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /** 获取平台对应的 Cookie */
  private getPlatformCookie(platform: Platform): string {
    const settings = loadSettings();
    switch (platform) {
      case 'douyin':
        return settings.cookieDouyin || settings.cookie || '';
      case 'bilibili':
        return settings.cookieBilibili || settings.cookie || '';
      case 'kuaishou':
        return settings.cookieKuaishou || settings.cookie || '';
      case 'soop':
        return settings.cookieSoop || settings.cookie || '';
      case 'pandalive':
        return settings.cookiePandalive || settings.cookie || '';
      case 'stripchat':
        return settings.cookieStripchat || settings.cookie || '';
      case 'xhs':
      default:
        return settings.cookieXhs || settings.cookie || '';
    }
  }

  async checkOne(streamerId: string) {
    const s = streamerRepo.get(streamerId);
    if (!s) throw new Error('主播不存在');
    await this.checkStreamer(s);
    return streamerRepo.get(streamerId);
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // 轮询所有主播的状态（无论是否启用监控），
      // 使卡片始终能实时反映在线/离线状态；
      // 仅启用了监控的主播在检测到开播时自动录制。
      const list = streamerRepo.list();
      for (const s of list) {
        try {
          // 每次检查前重新读取 DB 最新记录:
          // 防止 tick 期间用户点击「停止」(enabled 已落库为 false)后,
          // 旧快照(enabled=true)仍触发自动开录 —— 参考 StripchatRecorder-MobileUI:
          // 手动停止录制后不再自动重启录制。
          const fresh = streamerRepo.get(s.id);
          if (!fresh) continue;
          await this.checkStreamer(fresh);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[monitor] ${s.name}: ${msg}`);
          streamerRepo.update(s.id, {
            status: 'parse_error',
            lastError: msg,
            lastCheckedAt: nowIso(),
          });
        }
        // 轻微错开请求
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async checkStreamer(streamer: Streamer) {
    // 已在录制则只更新时间戳
    if (recorderService.isRecording(streamer.id)) {
      streamerRepo.update(streamer.id, {
        status: 'recording',
        lastCheckedAt: nowIso(),
      });
      // Stripchat:录制中仍刷新官方缩略图 URL(与 StripchatRecorder 一致,
      // 其监控循环在录制中照常轮询 cam API 获取 snapshotTimestamp 缩略图)
      if (streamer.platform === 'stripchat') {
        try {
          const cookie = this.getPlatformCookie('stripchat');
          // 仅调用轻量 getInfo(cam API),避免 getRoomInfo 额外请求 master 播放列表,
          // 每轮重复拉取大量数据导致限流
          const info = await getStripchatInfo(
            streamer.userId || streamer.roomId || streamer.name || '',
            {
              cookie: cookie || undefined,
              mouflonKeys: getMouflonKeys(),
            },
          );
          if (info.avatar) {
            streamerRepo.update(streamer.id, { avatar: info.avatar });
          }
        } catch {
          // 忽略:录制中缩略图刷新失败不影响录制
        }
      }
      return;
    }

    // 根据平台分发
    const platform = streamer.platform || 'xhs';
    if (platform === 'douyin') {
      await this.checkDouyinStreamer(streamer);
    } else if (platform === 'bilibili') {
      await this.checkBilibiliStreamer(streamer);
    } else if (platform === 'kuaishou') {
      await this.checkKuaishouStreamer(streamer);
    } else if (platform === 'soop') {
      await this.checkSoopStreamer(streamer);
    } else if (platform === 'pandalive') {
      await this.checkPandaliveStreamer(streamer);
    } else if (platform === 'stripchat') {
      await this.checkStripchatStreamer(streamer);
    } else {
      await this.checkXhsStreamer(streamer);
    }
  }

  /**
   * 哔哩哔哩主播监控逻辑
   * B站的 roomId 是稳定的，直接用 getInfo 检测直播状态
   */
  private async checkBilibiliStreamer(streamer: Streamer) {
    const cookie = this.getPlatformCookie('bilibili');
    const parser = new BilibiliParser({ cookie: cookie || undefined });

    let roomId: string | null = streamer.roomId;

    // 如果没有 roomId，尝试从 profileUrl 重新解析
    if (!roomId) {
      try {
        const info = await parser.resolveFromProfileUrl(
          streamer.profileUrl,
          cookie || undefined,
        );
        roomId = info.roomId;
        if (info.name) streamer.name = info.name;
        if (info.userId) streamer.userId = info.userId;
      } catch (e) {
        console.warn(
          `[monitor] bilibili resolve failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!roomId) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '无法获取B站房间ID，请确认链接正确',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    let living = false;
    let title = streamer.title || '';
    let owner = streamer.name;

    try {
      const info = await parser.getRoomInfo(roomId);
      living = info.living;
      if (info.title) title = info.title;
      if (info.owner) owner = info.owner;
      if (living) {
        console.log(`[monitor] bilibili detect: ${streamer.name} is LIVE roomId=${roomId}`);
      }
    } catch (e) {
      console.warn(
        `[monitor] bilibili check failed for ${streamer.name}:`,
        e instanceof Error ? e.message : e,
      );
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: e instanceof Error ? e.message : String(e),
        lastCheckedAt: nowIso(),
      });
      return;
    }

    // 在线时获取流地址并缓存（供快照端点使用），离线时清除缓存
    let cachedStreamUrl: string | null = null;
    if (living) {
      try {
        const streams = await parser.getStreams(roomId, ['flv', 'hls']);
        const stream =
          streams[0]?.streams.find((s) => s.format === 'flv') ||
          streams[0]?.streams[0];
        cachedStreamUrl = stream?.url || null;
        if (cachedStreamUrl) recorderService.setOnlineStreamUrl(streamer.id, cachedStreamUrl);
      } catch { /* ignore */ }
    } else {
      recorderService.clearOnlineStreamUrl(streamer.id);
    }

    streamerRepo.update(streamer.id, {
      name: owner || streamer.name,
      title: title || streamer.title,
      roomId,
      lastCheckedAt: nowIso(),
      lastError: living ? null : '暂未检测到开播。系统每轮持续监控，直播开始后自动录制',
      status: living ? 'online' : 'offline',
      lastLiveAt: living ? nowIso() : streamer.lastLiveAt,
    });

    if (!living || !streamer.enabled) return;

    if (!cachedStreamUrl) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '在播但未解析到流地址',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    const latest = streamerRepo.get(streamer.id)!;
    // 兜底:开录前再次用最新 enabled 校验,防止停止后旧快照自动重启录制
    if (!latest.enabled) return;
    await recorderService.start({
      streamer: latest,
      roomId,
      streamUrl: cachedStreamUrl,
      title,
    });
  }

  /**
   * 快手主播监控逻辑
   * 快手的 eid (用户ID) 是稳定的，通过页面解析检测直播状态
   */
  private async checkKuaishouStreamer(streamer: Streamer) {
    const cookie = this.getPlatformCookie('kuaishou');
    const parser = new KuaishouParser({ cookie: cookie || undefined });

    // 快手用 userId 或 roomId 作为 eid
    let eid: string | null = streamer.userId || streamer.roomId;

    // 如果没有 eid，尝试从 profileUrl 重新解析
    if (!eid) {
      try {
        const info = await parser.resolveFromProfileUrl(
          streamer.profileUrl,
          cookie || undefined,
        );
        eid = info.userId;
        if (info.name) streamer.name = info.name;
        if (info.userId) streamer.userId = info.userId;
      } catch (e) {
        console.warn(
          `[monitor] kuaishou resolve failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!eid) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '无法获取快手用户ID，请确认链接正确',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    let living = false;
    let title = streamer.title || '';
    let owner = streamer.name;
    let streamUrl: string | null = null;

    try {
      const info = await parser.getRoomInfo(eid);
      living = info.living;
      if (info.title) title = info.title;
      if (info.owner) owner = info.owner;
      // getRoomInfo 已通过 getInfoAndStream 一次性获取了流地址
      streamUrl = info.flvUrl || info.m3u8Url || null;
      if (living) {
        console.log(`[monitor] kuaishou detect: ${streamer.name} is LIVE eid=${eid}`);
      }
    } catch (e) {
      console.warn(
        `[monitor] kuaishou check failed for ${streamer.name}:`,
        e instanceof Error ? e.message : e,
      );
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: e instanceof Error ? e.message : String(e),
        lastCheckedAt: nowIso(),
      });
      return;
    }

    // 缓存/清除在线流地址（供快照端点使用）
    if (living && streamUrl) {
      recorderService.setOnlineStreamUrl(streamer.id, streamUrl);
    } else if (!living) {
      recorderService.clearOnlineStreamUrl(streamer.id);
    }

    streamerRepo.update(streamer.id, {
      name: owner || streamer.name,
      title: title || streamer.title,
      userId: eid,
      lastCheckedAt: nowIso(),
      lastError: living ? null : '暂未检测到开播。系统每轮持续监控，直播开始后自动录制',
      status: living ? 'online' : 'offline',
      lastLiveAt: living ? nowIso() : streamer.lastLiveAt,
    });

    if (!living || !streamer.enabled) return;

    // 使用 getRoomInfo 已获取的流地址开录（避免重复请求页面导致限流）
    if (!streamUrl) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '在播但未解析到流地址',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    const latest = streamerRepo.get(streamer.id)!;
    // 兜底:开录前再次用最新 enabled 校验,防止停止后旧快照自动重启录制
    if (!latest.enabled) return;
    await recorderService.start({
      streamer: latest,
      roomId: eid,
      streamUrl,
      title,
    });
  }

  /**
   * SOOP (原 AfreecaTV) 主播监控逻辑
   * SOOP 的 bjId 是稳定的，通过站点状态 API 检测直播状态
   * 需要登录时使用 settings 中的 soopUsername/soopPassword
   */
  private async checkSoopStreamer(streamer: Streamer) {
    const settings = loadSettings();
    // 设置 SOOP 代理 (可选，用于特殊网络环境)
    const cookie = this.getPlatformCookie('soop');
    const parser = new SoopParser({
      cookie: cookie || undefined,
      username: settings.soopUsername || undefined,
      password: settings.soopPassword || undefined,
    });

    // SOOP 用 userId (bjId) 作为唯一标识
    let bjId: string | null = streamer.userId;

    // 如果没有 bjId，尝试从 profileUrl 重新解析
    if (!bjId) {
      try {
        const info = await parser.resolveFromProfileUrl(
          streamer.profileUrl,
          cookie || undefined,
        );
        bjId = info.userId;
        // SOOP: 不覆盖主播ID名称
        if (info.userId) streamer.userId = info.userId;
      } catch (e) {
        console.warn(
          `[monitor] soop resolve failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!bjId) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '无法获取 SOOP 主播ID (bjId)，请确认链接正确',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    let living = false;
    let title = streamer.title || '';
    let owner = streamer.name;
    let streamUrl: string | null = null;

    try {
      const info = await parser.getRoomInfo(bjId);
      living = info.living;
      if (info.title) title = info.title;
      if (info.owner) owner = info.owner;
      streamUrl = info.m3u8Url || null;
      if (living) {
        console.log(`[monitor] soop detect: ${streamer.name} is LIVE bjId=${bjId}`);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[monitor] soop check failed for ${streamer.name}:`,
        errMsg,
      );
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: errMsg,
        lastCheckedAt: nowIso(),
      });
      return;
    }

    // 缓存/清除在线流地址（供快照端点使用）
    if (living && streamUrl) {
      recorderService.setOnlineStreamUrl(streamer.id, streamUrl);
    } else if (!living) {
      recorderService.clearOnlineStreamUrl(streamer.id);
    }

    streamerRepo.update(streamer.id, {
      // SOOP: 保持主播ID作为显示名称，不覆盖为昵称
      name: streamer.name,
      title: title || streamer.title,
      userId: bjId,
      lastCheckedAt: nowIso(),
      lastError: living ? null : '暂未检测到开播。系统每轮持续监控，直播开始后自动录制',
      status: living ? 'online' : 'offline',
      lastLiveAt: living ? nowIso() : streamer.lastLiveAt,
    });

    if (!living || !streamer.enabled) return;

    // 使用 getRoomInfo 已获取的流地址开录，若无则按画质重新获取
    if (!streamUrl) {
      try {
        const streams = await parser.getStreams(
          bjId,
          ['hls'],
          streamer.recordQuality,
        );
        streamUrl = streams[0]?.streams[0]?.url || null;
        if (streamUrl) recorderService.setOnlineStreamUrl(streamer.id, streamUrl);
      } catch (e) {
        console.warn(
          `[monitor] soop getStreams failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!streamUrl) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '在播但未解析到流地址',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    const latest = streamerRepo.get(streamer.id)!;
    // 兜底:开录前再次用最新 enabled 校验,防止停止后旧快照自动重启录制
    if (!latest.enabled) return;
    await recorderService.start({
      streamer: latest,
      roomId: bjId,
      streamUrl,
      title,
    });
  }

  /**
   * Pandalive 主播监控逻辑
   * Pandalive 的 userId 是稳定的，通过 member/bj API 检测直播状态
   */
  private async checkPandaliveStreamer(streamer: Streamer) {
    const cookie = this.getPlatformCookie('pandalive');
    const parser = new PandaliveParser({ cookie: cookie || undefined });

    // Pandalive 用 userId 作为唯一标识
    let userId: string | null = streamer.userId;

    // 如果没有 userId，尝试从 profileUrl 重新解析
    if (!userId) {
      try {
        const info = await parser.resolveFromProfileUrl(
          streamer.profileUrl,
          cookie || undefined,
        );
        userId = info.userId;
        // Pandalive: 不覆盖主播ID名称
        if (info.userId) streamer.userId = info.userId;
      } catch (e) {
        console.warn(
          `[monitor] pandalive resolve failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!userId) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '无法获取 Pandalive 用户ID，请确认链接正确',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    let living = false;
    let title = streamer.title || '';
    let owner = streamer.name;
    let streamUrl: string | null = null;

    try {
      const info = await parser.getRoomInfo(userId);
      living = info.living;
      if (info.title) title = info.title;
      if (info.owner) owner = info.owner;
      streamUrl = info.m3u8Url || null;
      if (living) {
        console.log(`[monitor] pandalive detect: ${streamer.name} is LIVE userId=${userId}`);
      }
    } catch (e) {
      console.warn(
        `[monitor] pandalive check failed for ${streamer.name}:`,
        e instanceof Error ? e.message : e,
      );
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: e instanceof Error ? e.message : String(e),
        lastCheckedAt: nowIso(),
      });
      return;
    }

    // 缓存/清除在线流地址（供快照端点使用）
    if (living && streamUrl) {
      recorderService.setOnlineStreamUrl(streamer.id, streamUrl);
    } else if (!living) {
      recorderService.clearOnlineStreamUrl(streamer.id);
    }

    streamerRepo.update(streamer.id, {
      // Pandalive: 保持主播ID作为显示名称，不覆盖为昵称
      name: streamer.name,
      title: title || streamer.title,
      userId,
      lastCheckedAt: nowIso(),
      lastError: living ? null : '暂未检测到开播。系统每轮持续监控，直播开始后自动录制',
      status: living ? 'online' : 'offline',
      lastLiveAt: living ? nowIso() : streamer.lastLiveAt,
    });

    if (!living || !streamer.enabled) return;

    // 使用 getRoomInfo 已获取的流地址开录，若无则按画质重新获取
    if (!streamUrl) {
      try {
        const streams = await parser.getStreams(
          userId,
          ['hls'],
          streamer.recordQuality,
        );
        streamUrl = streams[0]?.streams[0]?.url || null;
        if (streamUrl) recorderService.setOnlineStreamUrl(streamer.id, streamUrl);
      } catch (e) {
        console.warn(
          `[monitor] pandalive getStreams failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!streamUrl) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '在播但未解析到流地址',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    const latest = streamerRepo.get(streamer.id)!;
    // 兜底:开录前再次用最新 enabled 校验,防止停止后旧快照自动重启录制
    if (!latest.enabled) return;
    await recorderService.start({
      streamer: latest,
      roomId: userId,
      streamUrl,
      title,
    });
  }

  /**
   * 抖音主播监控逻辑
   * 抖音的 webRid(roomId) 是稳定的，直接用 getRoomInfo 检测直播状态
   */
  private async checkDouyinStreamer(streamer: Streamer) {
    const cookie = this.getPlatformCookie('douyin');
    const parser = new DouyinParser({ cookie: cookie || undefined });

    let roomId: string | null = streamer.roomId;

    // 如果没有 roomId，尝试从 profileUrl 重新解析
    if (!roomId) {
      try {
        const info = await parser.resolveFromProfileUrl(streamer.profileUrl);
        roomId = info.roomId;
        if (info.name) streamer.name = info.name;
        if (info.userId) streamer.userId = info.userId;
      } catch (e) {
        console.warn(
          `[monitor] douyin resolve failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!roomId) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '无法获取抖音房间ID，请确认链接正确',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    let living = false;
    let title = streamer.title || '';
    let owner = streamer.name;

    try {
      const info = await parser.getRoomInfo(roomId);
      living = info.living;
      if (info.title) title = info.title;
      if (info.owner) owner = info.owner;
      if (living) {
        console.log(`[monitor] douyin detect: ${streamer.name} is LIVE roomId=${roomId}`);
      }
    } catch (e) {
      console.warn(
        `[monitor] douyin check failed for ${streamer.name}:`,
        e instanceof Error ? e.message : e,
      );
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: e instanceof Error ? e.message : String(e),
        lastCheckedAt: nowIso(),
      });
      return;
    }

    // 在线时获取流地址并缓存（供快照端点使用），离线时清除缓存
    let cachedStreamUrl: string | null = null;
    if (living) {
      try {
        const streams = await parser.getStreams(roomId, ['flv', 'hls']);
        const stream =
          streams[0]?.streams.find((s) => s.format === 'flv') ||
          streams[0]?.streams[0];
        cachedStreamUrl = stream?.url || null;
        if (cachedStreamUrl) recorderService.setOnlineStreamUrl(streamer.id, cachedStreamUrl);
      } catch { /* ignore */ }
    } else {
      recorderService.clearOnlineStreamUrl(streamer.id);
    }

    streamerRepo.update(streamer.id, {
      name: owner || streamer.name,
      title: title || streamer.title,
      roomId,
      lastCheckedAt: nowIso(),
      lastError: living ? null : '暂未检测到开播。系统每轮持续监控，直播开始后自动录制',
      status: living ? 'online' : 'offline',
      lastLiveAt: living ? nowIso() : streamer.lastLiveAt,
    });

    if (!living || !streamer.enabled) return;

    if (!cachedStreamUrl) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '在播但未解析到流地址',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    const latest = streamerRepo.get(streamer.id)!;
    // 兜底:开录前再次用最新 enabled 校验,防止停止后旧快照自动重启录制
    if (!latest.enabled) return;
    await recorderService.start({
      streamer: latest,
      roomId,
      streamUrl: cachedStreamUrl,
      title,
    });
  }

  /**
   * 小红书主播监控逻辑
   */
  private async checkXhsStreamer(streamer: Streamer) {
    const cookie = this.getPlatformCookie('xhs');
    const parser = new XhsParser({ cookie: cookie || undefined });

    let roomId: string | null = streamer.roomId;
    let living = false;
    let title = streamer.title || '';
    let owner = streamer.name;

    // 策略1（首选，无需特殊签名）：始终尝试从用户主页页面检测直播状态
    if (streamer.userId) {
      try {
        const profileLive = await parser.checkLiveFromProfilePage(streamer.userId);
        if (profileLive.living && profileLive.roomId) {
          living = true;
          roomId = profileLive.roomId;
          title = profileLive.title || title;
          if (profileLive.owner) owner = profileLive.owner;
          console.log(`[monitor] profile detect: ${streamer.name} is LIVE roomId=${roomId}`);
        }
      } catch (e) {
        console.warn(
          `[monitor] profile check failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    // 策略2（增强）：Cookie + redId → usersearch
    if (!living && cookie && streamer.redId) {
      try {
        const live = await parser.checkLiveByRedId(streamer.redId, cookie);
        if (live.living) {
          living = true;
          if (live.roomId) roomId = live.roomId;
          if (live.owner) owner = live.owner;
          console.log(`[monitor] usersearch detect: ${streamer.name} is LIVE roomId=${roomId}`);
        }
      } catch (e) {
        console.warn(
          `[monitor] usersearch failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    // 策略3（兜底）：有旧 roomId 时用直播页确认
    if (!living && roomId) {
      try {
        const info = await parser.getRoomInfo(roomId);
        if (info.living) {
          living = true;
          if (info.roomId) roomId = info.roomId;
          if (info.title) title = info.title;
          if (info.owner) owner = info.owner;
          console.log(`[monitor] room page detect: ${streamer.name} is LIVE roomId=${roomId}`);
        } else {
          roomId = null;
        }
      } catch (e) {
        roomId = null;
        console.warn(
          `[monitor] room page check failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    // 已检测到直播 + 有 roomId → 补标题
    if (living && roomId) {
      try {
        const info = await parser.getRoomInfo(roomId);
        if (info.title) title = info.title;
        if (info.owner) owner = info.owner;
        living = info.living || living;
      } catch {
        // 已有的检测结果足以继续
      }
    }

    // 在线时获取流地址并缓存（供快照端点使用），离线时清除缓存
    let cachedStreamUrl: string | null = null;
    if (living && roomId) {
      try {
        const streams = await parser.getStreams(roomId, ['flv', 'hls']);
        const stream =
          streams[0]?.streams.find((s) => s.format === 'flv') ||
          streams[0]?.streams[0];
        cachedStreamUrl = stream?.url || null;
        if (cachedStreamUrl) recorderService.setOnlineStreamUrl(streamer.id, cachedStreamUrl);
      } catch { /* ignore */ }
    } else {
      recorderService.clearOnlineStreamUrl(streamer.id);
    }

    streamerRepo.update(streamer.id, {
      name: owner || streamer.name,
      title: title || streamer.title,
      roomId,
      lastCheckedAt: nowIso(),
      lastError: living ? null : '暂未检测到开播。系统每轮持续监控，直播开始后自动录制',
      status: living ? 'online' : 'offline',
      lastLiveAt: living ? nowIso() : streamer.lastLiveAt,
    });

    if (!living || !roomId || !streamer.enabled) return;

    if (!cachedStreamUrl) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '在播但未解析到流地址',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    const latest = streamerRepo.get(streamer.id)!;
    // 兜底:开录前再次用最新 enabled 校验,防止停止后旧快照自动重启录制
    if (!latest.enabled) return;
    await recorderService.start({
      streamer: latest,
      roomId,
      streamUrl: cachedStreamUrl,
      title,
    });
  }

  /**
   * Stripchat 主播监控逻辑
   * Stripchat 的 username 是稳定的,通过 cam API 检测直播状态
   * 仅 public 状态的直播可录制(与 StripchatRecorder 一致)
   */
  private async checkStripchatStreamer(streamer: Streamer) {
    const cookie = this.getPlatformCookie('stripchat');
    const parser = new StripchatParser({
      cookie: cookie || undefined,
      mouflonKeys: getMouflonKeys(),
    });

    // Stripchat 用 userId (username) 作为唯一标识
    let username: string | null = streamer.userId;

    // 如果没有 username,尝试从 profileUrl 重新解析
    if (!username) {
      try {
        const info = await parser.resolveFromProfileUrl(
          streamer.profileUrl,
          cookie || undefined,
        );
        username = info.userId;
        if (info.userId) streamer.userId = info.userId;
      } catch (e) {
        console.warn(
          `[monitor] stripchat resolve failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!username) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '无法获取 Stripchat 主播用户名,请确认链接正确',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    let living = false;
    let title = streamer.title || '';
    let owner = streamer.name;
    let streamUrl: string | null = null;
    /** 官方直播缩略图 URL(在线=img.doppiocdn.net/thumbs/...,离线=previewUrl) */
    let liveAvatar: string | null = null;

    try {
      const info = await parser.getRoomInfo(username);
      living = info.living;
      if (info.title) title = info.title;
      if (info.owner) owner = info.owner;
      streamUrl = info.m3u8Url || null;
      liveAvatar = info.avatar || null;
      if (living) {
        console.log(`[monitor] stripchat detect: ${streamer.name} is LIVE username=${username}`);
      }
    } catch (e) {
      console.warn(
        `[monitor] stripchat check failed for ${streamer.name}:`,
        e instanceof Error ? e.message : e,
      );
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: e instanceof Error ? e.message : String(e),
        lastCheckedAt: nowIso(),
      });
      return;
    }

    // 缓存/清除在线流地址(供快照端点使用)
    if (living && streamUrl) {
      recorderService.setOnlineStreamUrl(streamer.id, streamUrl);
    } else if (!living) {
      recorderService.clearOnlineStreamUrl(streamer.id);
    }

    streamerRepo.update(streamer.id, {
      // Stripchat: 保持用户名作为显示名称
      name: streamer.name,
      title: title || streamer.title,
      userId: username,
      // 官方直播缩略图 URL 随轮询更新(与 StripchatRecorder 一致:
      // 在线 = img.doppiocdn.net/thumbs/{snapshotTimestamp}/{streamName},离线 = previewUrl)
      avatar: liveAvatar || streamer.avatar,
      lastCheckedAt: nowIso(),
      lastError: living ? null : '暂未检测到开播。系统每轮持续监控,直播开始后自动录制',
      status: living ? 'online' : 'offline',
      lastLiveAt: living ? nowIso() : streamer.lastLiveAt,
    });

    if (!living || !streamer.enabled) return;

    // 使用 getRoomInfo 已获取的流地址开录,若无则按画质重新获取
    if (!streamUrl) {
      try {
        const streams = await parser.getStreams(
          username,
          ['hls'],
          streamer.recordQuality,
        );
        streamUrl = streams[0]?.streams[0]?.url || null;
        if (streamUrl) recorderService.setOnlineStreamUrl(streamer.id, streamUrl);
      } catch (e) {
        console.warn(
          `[monitor] stripchat getStreams failed for ${streamer.name}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (!streamUrl) {
      streamerRepo.update(streamer.id, {
        status: 'parse_error',
        lastError: '在播但未解析到流地址(可能为私密/群组秀,仅 public 公开秀可录制)',
        lastCheckedAt: nowIso(),
      });
      return;
    }

    const latest = streamerRepo.get(streamer.id)!;
    // 兜底:开录前再次用最新 enabled 校验,防止停止后旧快照自动重启录制
    if (!latest.enabled) return;
    await recorderService.start({
      streamer: latest,
      roomId: username,
      streamUrl,
      title,
    });
  }
}

export const monitorService = new MonitorService();
