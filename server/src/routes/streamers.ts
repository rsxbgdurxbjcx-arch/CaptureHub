import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PATHS, loadSettings } from '../config.js';
import { streamerRepo, fileRepo, markPathPendingDelete } from '../db/index.js';
import { monitorService } from '../services/monitor.js';
import { recorderService } from '../services/recorder.js';
import { postProcessService } from '../services/postprocess.js';
import type { ApiResponse, Streamer, Platform, RecordQuality } from '../types.js';
import { newId, nowIso, sleep } from '../utils.js';
import { XhsParser } from '../xhs/parser.js';
import { DouyinParser } from '../douyin/parser.js';
import { BilibiliParser } from '../bilibili/parser.js';
import { KuaishouParser } from '../kuaishou/parser.js';
import { SoopParser } from '../soop/parser.js';
import { PandaliveParser } from '../pandalive/parser.js';
import { StripchatParser } from '../stripchat/index.js';
import { getMouflonKeys } from '../stripchat/mouflon.js';

export const streamersRouter = Router();

function normalizeUrl(input: string) {
  const u = input.trim();
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u}`;
}

/** 根据 URL 自动推断平台 */
function detectPlatform(url: string): Platform {
  if (/douyin\.com/i.test(url)) return 'douyin';
  if (/bilibili\.com|live\.bilibili/i.test(url)) return 'bilibili';
  if (/kuaishou\.com|live\.kuaishou/i.test(url)) return 'kuaishou';
  if (/sooplive\.com|sooplive\.co\.kr|afreecatv\.com/i.test(url)) return 'soop';
  if (/pandalive\.co\.kr/i.test(url)) return 'pandalive';
  if (/stripchat\.com/i.test(url)) return 'stripchat';
  return 'xhs';
}

/** 获取平台对应的 Cookie */
function getPlatformCookie(platform: Platform): string {
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

const urlLike = z
  .string()
  .min(8)
  .refine(
    (v) =>
      /^(https?:\/\/)?([\w-]+\.)?(xiaohongshu\.com|xhslink\.com|douyin\.com|v\.douyin\.com|bilibili\.com|live\.bilibili\.com|space\.bilibili\.com|kuaishou\.com|live\.kuaishou\.com|sooplive\.com|sooplive\.co\.kr|afreecatv\.com|pandalive\.co\.kr|stripchat\.com)\//i.test(
        v.trim(),
      ),
    '请输入有效的小红书、抖音、哔哩哔哩、快手、SOOP、Pandalive 或 Stripchat 链接',
  );

const upsertSchema = z.object({
  name: z.string().optional(),
  profileUrl: urlLike,
  platform: z.enum(['xhs', 'douyin', 'bilibili', 'kuaishou', 'soop', 'pandalive', 'stripchat']).optional(),
  enabled: z.boolean().optional(),
  downloader: z
    .enum(['global', 'ffmpeg'])
    .optional(),
  recordQuality: z.enum(['OD', 'UHD', 'HD', 'SD', 'LD']).optional(),
  redId: z.string().optional().nullable(),
  roomId: z.string().optional().nullable(),
});

/* ============================================================
   直播画面快照:从当前录制中的直播流抓取一帧 JPEG
   - 仅对正在录制(有活跃 streamUrl)的主播可用
   - 内存缓存 2.5 秒,避免每 3 秒刷新时重复拉起 ffmpeg
   - 同一主播并发请求加锁,复用缓存或快速返回
   ============================================================ */
const snapshotCache = new Map<string, { buf: Buffer; ts: number }>();
const snapshotLocks = new Set<string>();
const SNAPSHOT_TTL_MS = 2500;
const SNAPSHOT_TIMEOUT_MS = 6000;

function captureFrame(ffmpeg: string, streamUrl: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-rw_timeout', '4000000',
      '-i', streamUrl,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '4',
      '-',
    ];
    let child;
    try {
      child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(Buffer.alloc(0));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, SNAPSHOT_TIMEOUT_MS);
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}

streamersRouter.get('/:id/snapshot', async (req, res) => {
  const id = req.params.id;
  const streamUrl = recorderService.getStreamUrl(id);
  if (!streamUrl) {
    res.status(404).json({ ok: false, error: '当前无可用直播流' } satisfies ApiResponse);
    return;
  }

  const cached = snapshotCache.get(id);
  if (cached && Date.now() - cached.ts < SNAPSHOT_TTL_MS) {
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(cached.buf);
    return;
  }

  // 并发请求:复用缓存,避免同时拉起多个 ffmpeg
  if (snapshotLocks.has(id)) {
    if (cached) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      res.send(cached.buf);
      return;
    }
    res.status(503).json({ ok: false, error: '快照生成中,请稍后' } satisfies ApiResponse);
    return;
  }

  snapshotLocks.add(id);
  try {
    const settings = loadSettings();
    const buf = await captureFrame(settings.ffmpegPath, streamUrl);
    if (buf.length > 0) {
      snapshotCache.set(id, { buf, ts: Date.now() });
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } else if (cached) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      res.send(cached.buf);
    } else {
      res.status(502).json({ ok: false, error: '快照捕获失败' } satisfies ApiResponse);
    }
  } catch {
    if (cached) {
      res.set('Content-Type', 'image/jpeg');
      res.send(cached.buf);
    } else {
      res.status(502).json({ ok: false, error: '快照捕获失败' } satisfies ApiResponse);
    }
  } finally {
    snapshotLocks.delete(id);
  }
});

streamersRouter.get('/', (_req, res) => {
  const data = streamerRepo.list();
  const body: ApiResponse<Streamer[]> = { ok: true, data };
  res.json(body);
});

streamersRouter.get('/:id', (req, res) => {
  const s = streamerRepo.get(req.params.id);
  if (!s) {
    res.status(404).json({ ok: false, error: '主播不存在' } satisfies ApiResponse);
    return;
  }
  res.json({ ok: true, data: s } satisfies ApiResponse<Streamer>);
});

streamersRouter.post('/', async (req, res) => {
  try {
    const parsed = upsertSchema.parse(req.body);
    const profileUrl = normalizeUrl(parsed.profileUrl);
    const platform: Platform = parsed.platform || detectPlatform(profileUrl);

    let info: {
      userId: string;
      redId: string | null;
      name: string;
      avatar: string;
      roomId: string | null;
      living: boolean;
      title: string;
    };

    const cookie = getPlatformCookie(platform);

    if (platform === 'douyin') {
      const parser = new DouyinParser({ cookie: cookie || undefined });
      if (!parser.matchURL(profileUrl)) {
        res.status(400).json({
          ok: false,
          error: '请输入抖音主页/直播链接 (douyin.com)',
        } satisfies ApiResponse);
        return;
      }
      info = await parser.resolveFromProfileUrl(
        profileUrl,
        cookie || undefined,
      );
    } else if (platform === 'bilibili') {
      const parser = new BilibiliParser({ cookie: cookie || undefined });
      if (!parser.matchURL(profileUrl)) {
        res.status(400).json({
          ok: false,
          error: '请输入B站直播间/用户主页链接 (live.bilibili.com 或 space.bilibili.com)',
        } satisfies ApiResponse);
        return;
      }
      info = await parser.resolveFromProfileUrl(
        profileUrl,
        cookie || undefined,
      );
    } else if (platform === 'kuaishou') {
      const parser = new KuaishouParser({ cookie: cookie || undefined });
      if (!parser.matchURL(profileUrl)) {
        res.status(400).json({
          ok: false,
          error: '请输入快手直播间/用户主页链接 (live.kuaishou.com)',
        } satisfies ApiResponse);
        return;
      }
      info = await parser.resolveFromProfileUrl(
        profileUrl,
        cookie || undefined,
      );
    } else if (platform === 'soop') {
      const settings = loadSettings();
      const parser = new SoopParser({
        cookie: cookie || undefined,
        username: settings.soopUsername || undefined,
        password: settings.soopPassword || undefined,
      });
      if (!parser.matchURL(profileUrl)) {
        res.status(400).json({
          ok: false,
          error: '请输入 SOOP 直播间/主播主页链接 (sooplive.com 或 afreecatv.com)',
        } satisfies ApiResponse);
        return;
      }
      info = await parser.resolveFromProfileUrl(
        profileUrl,
        cookie || undefined,
      );
    } else if (platform === 'pandalive') {
      const parser = new PandaliveParser({ cookie: cookie || undefined });
      if (!parser.matchURL(profileUrl)) {
        res.status(400).json({
          ok: false,
          error: '请输入 Pandalive 主播主页链接 (pandalive.co.kr)',
        } satisfies ApiResponse);
        return;
      }
      info = await parser.resolveFromProfileUrl(
        profileUrl,
        cookie || undefined,
      );
    } else if (platform === 'stripchat') {
      const parser = new StripchatParser({
        cookie: cookie || undefined,
        mouflonKeys: getMouflonKeys(),
      });
      if (!parser.matchURL(profileUrl)) {
        res.status(400).json({
          ok: false,
          error: '请输入 Stripchat 主播主页/直播间链接 (stripchat.com)',
        } satisfies ApiResponse);
        return;
      }
      info = await parser.resolveFromProfileUrl(
        profileUrl,
        cookie || undefined,
      );
    } else {
      const parser = new XhsParser({ cookie: cookie || undefined });
      if (!parser.matchURL(profileUrl)) {
        res.status(400).json({
          ok: false,
          error: '请输入小红书主页/直播/分享链接 (xiaohongshu.com 或 xhslink.com)',
        } satisfies ApiResponse);
        return;
      }
      info = await parser.resolveFromProfileUrl(
        profileUrl,
        cookie || undefined,
      );
    }

    const now = nowIso();
    // SOOP/Pandalive/Stripchat: 显示名称自动使用主播ID (userId/username)
    const useStreamerId = platform === 'soop' || platform === 'pandalive' || platform === 'stripchat';
    // 主播卡片显示名称(与创建时一致):SOOP/PandaLive 用主播ID,其余用用户填写名或解析名
    const displayName = useStreamerId
      ? (info.userId || info.name || '未知主播')
      : (parsed.name?.trim() || info.name || '未知主播');

    // 检查重复主播:通过显示名称判断(同平台同名视为同一主播,禁止重复添加)
    const existing = streamerRepo
      .list()
      .find((s) => s.platform === platform && s.name === displayName);
    if (existing) {
      res.status(409).json({
        ok: false,
        error: `该主播已添加过(平台:${platform},名称:${displayName}),请勿重复添加`,
      } satisfies ApiResponse);
      return;
    }

    const streamer: Streamer = {
      id: newId('st'),
      name: displayName,
      profileUrl,
      platform,
      roomId: parsed.roomId ?? info.roomId,
      userId: info.userId,
      redId: parsed.redId ?? info.redId,
      avatar: info.avatar || null,
      // 添加主播时获取一次头像并长久固定;失败保持空(前端显示占位符),后续不再重新获取
      avatarUpdatedAt: info.avatar ? now : null,
      title: info.title || null,
      status: info.living ? 'online' : 'offline',
      enabled: parsed.enabled ?? true,
      downloader: parsed.downloader ?? 'global',
      recordQuality: (parsed.recordQuality as RecordQuality) || 'OD',
      lastError: null,
      lastCheckedAt: now,
      lastLiveAt: info.living ? now : null,
      createdAt: now,
      updatedAt: now,
    };

    streamerRepo.create(streamer);
    res.status(201).json({ ok: true, data: streamer } satisfies ApiResponse<Streamer>);

    // 异步立即检查一次
    void monitorService.checkOne(streamer.id).catch(() => undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

streamersRouter.put('/:id', async (req, res) => {
  try {
    const cur = streamerRepo.get(req.params.id);
    if (!cur) {
      res.status(404).json({ ok: false, error: '主播不存在' } satisfies ApiResponse);
      return;
    }
    const parsed = upsertSchema
      .partial()
      .extend({
        profileUrl: urlLike.optional(),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    let patch: Partial<Streamer> = {
      name: parsed.name ?? cur.name,
      enabled: parsed.enabled ?? cur.enabled,
      downloader: parsed.downloader ?? cur.downloader,
      recordQuality: (parsed.recordQuality as RecordQuality) ?? cur.recordQuality,
      redId: parsed.redId === undefined ? cur.redId : parsed.redId,
      roomId: parsed.roomId === undefined ? cur.roomId : parsed.roomId,
      platform: parsed.platform ?? cur.platform,
    };

    if (parsed.profileUrl && normalizeUrl(parsed.profileUrl) !== cur.profileUrl) {
      const profileUrl = normalizeUrl(parsed.profileUrl);
      const platform: Platform = parsed.platform || detectPlatform(profileUrl);
      const cookie = getPlatformCookie(platform);

      let info;
      if (platform === 'douyin') {
        const parser = new DouyinParser({ cookie: cookie || undefined });
        info = await parser.resolveFromProfileUrl(
          profileUrl,
          cookie || undefined,
        );
      } else if (platform === 'bilibili') {
        const parser = new BilibiliParser({ cookie: cookie || undefined });
        info = await parser.resolveFromProfileUrl(
          profileUrl,
          cookie || undefined,
        );
      } else if (platform === 'kuaishou') {
        const parser = new KuaishouParser({ cookie: cookie || undefined });
        info = await parser.resolveFromProfileUrl(
          profileUrl,
          cookie || undefined,
        );
      } else if (platform === 'soop') {
        const settings = loadSettings();
        const parser = new SoopParser({
          cookie: cookie || undefined,
          username: settings.soopUsername || undefined,
          password: settings.soopPassword || undefined,
        });
        info = await parser.resolveFromProfileUrl(
          profileUrl,
          cookie || undefined,
        );
      } else if (platform === 'pandalive') {
        const parser = new PandaliveParser({ cookie: cookie || undefined });
        info = await parser.resolveFromProfileUrl(
          profileUrl,
          cookie || undefined,
        );
      } else if (platform === 'stripchat') {
        const parser = new StripchatParser({
          cookie: cookie || undefined,
          mouflonKeys: getMouflonKeys(),
        });
        info = await parser.resolveFromProfileUrl(
          profileUrl,
          cookie || undefined,
        );
      } else {
        const parser = new XhsParser({ cookie: cookie || undefined });
        info = await parser.resolveFromProfileUrl(
          profileUrl,
          cookie || undefined,
        );
      }
      // SOOP/Pandalive/Stripchat: 显示名称自动使用主播ID
      const useStreamerIdPut = platform === 'soop' || platform === 'pandalive' || platform === 'stripchat';
      patch = {
        ...patch,
        profileUrl,
        platform,
        userId: info.userId,
        redId: parsed.redId ?? info.redId,
        roomId: parsed.roomId ?? info.roomId,
        // 头像仅在添加主播时获取一次,编辑不再重新获取
        name: useStreamerIdPut
          ? (info.userId || info.name || cur.name)
          : (parsed.name?.trim() || info.name || cur.name),
      };
    }

    const next = streamerRepo.update(cur.id, patch);
    res.json({ ok: true, data: next } satisfies ApiResponse<Streamer | null>);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

/**
 * 删除主播时清理其快照缓存与锁定标记,防止内存中的大 Buffer 长期残留
 */
function clearStreamerSnapshotCache(id: string) {
  snapshotCache.delete(id);
  snapshotLocks.delete(id);
}

/**
 * 删除主播及其全部文件(已录制 + 正在录制):
 * 1. 等待录制停止(确保段文件落盘、close 处理器完成入队);
 * 2. 丢弃该主播文件的排队后处理任务与进度,防止已删文件被再次上传;
 * 3. 删除物理文件(带重试 + 墓碑登记防复活)与全部文件记录;
 * 4. 删除主播记录、清理快照缓存与空文件夹。
 *
 * 文件归属规则:优先按 streamer_id 精确匹配;
 * 磁盘同步产生的记录(streamer_id=null)仅在"没有其他同主播名主播"时按名称匹配,
 * 避免误删不同平台同名主播(共用同一录制文件夹)的文件。
 */
async function removeStreamerWithFiles(
  id: string,
): Promise<{ removedStreamer: boolean; removedFiles: number }> {
  const cur = streamerRepo.get(id);
  if (!cur) return { removedStreamer: false, removedFiles: 0 };

  // 1. 等待录制停止(ffmpeg 优雅收尾 / Stripchat 分片合并入队)
  if (recorderService.isRecording(id)) {
    await recorderService.stop(id, 'manual_stop').catch((e) => {
      console.warn('[streamers] 删除前停止录制失败(继续删除):', e instanceof Error ? e.message : e);
    });
  }

  const sameNameOthers = streamerRepo.list().some(
    (s) => s.id !== id && s.name === cur.name,
  );
  const files = fileRepo.list().filter(
    (f) =>
      f.streamerId === id ||
      (!sameNameOthers && f.streamerId === null && f.streamerName === cur.name),
  );

  // 2. 丢弃排队中的后处理任务与进度
  postProcessService.discard(files.map((f) => f.id));

  // 3. 删除物理文件(带重试)与文件记录
  let removedFiles = 0;
  const dirsToCleanup = new Set<string>();
  for (const f of files) {
    if (f.absolutePath) {
      markPathPendingDelete(f.absolutePath);
      if (fs.existsSync(f.absolutePath)) {
        for (let i = 0; i < 5; i++) {
          try {
            fs.unlinkSync(f.absolutePath);
            break;
          } catch (e) {
            if (i === 4) {
              console.warn(
                `[streamers] 删除文件失败(重试后仍失败): ${f.absolutePath}`,
                e instanceof Error ? e.message : e,
              );
            } else {
              await sleep(300);
            }
          }
        }
      }
      dirsToCleanup.add(path.dirname(f.absolutePath));
    }
    fileRepo.remove(f.id);
    removedFiles++;
  }

  // 4. 删除主播记录 + 快照缓存
  streamerRepo.remove(id);
  clearStreamerSnapshotCache(id);

  // 清理空文件夹(仅当目录内无普通内容,且不是 recordings 根目录本身)
  for (const d of dirsToCleanup) {
    try {
      if (path.resolve(d) === path.resolve(PATHS.recordings)) continue;
      const entries = fs.readdirSync(d);
      const onlyCleanable = entries.every((n) => n.startsWith('.'));
      if (onlyCleanable) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    } catch { /* ignore: 目录不存在/非空/无权时跳过 */ }
  }

  return { removedStreamer: true, removedFiles };
}

streamersRouter.delete('/:id', async (req, res) => {
  try {
    const result = await removeStreamerWithFiles(req.params.id);
    if (!result.removedStreamer) {
      res.status(404).json({ ok: false, error: '主播不存在' } satisfies ApiResponse);
      return;
    }
    res.json({
      ok: true,
      message: result.removedFiles > 0
        ? `已删除主播及其 ${result.removedFiles} 个文件`
        : '已删除主播',
    } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

/** 批量删除主播(含各自文件) */
streamersRouter.post('/batch/delete', async (req, res) => {
  const ids = (req.body?.ids as string[]) || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ ok: false, error: '请提供要删除的主播ID列表' } satisfies ApiResponse);
    return;
  }
  let deleted = 0;
  let removedFiles = 0;
  for (const id of ids) {
    const result = await removeStreamerWithFiles(id);
    if (result.removedStreamer) {
      deleted++;
      removedFiles += result.removedFiles;
    }
  }
  res.json({
    ok: true,
    data: streamerRepo.list(),
    message: removedFiles > 0
      ? `已删除 ${deleted} 个主播及其 ${removedFiles} 个文件`
      : `已删除 ${deleted} 个主播`,
  } satisfies ApiResponse);
});

streamersRouter.post('/:id/check', async (req, res) => {
  try {
    const data = await monitorService.checkOne(req.params.id);
    if (!data) {
      res.status(404).json({ ok: false, error: '主播不存在' } satisfies ApiResponse);
      return;
    }
    res.json({ ok: true, data } satisfies ApiResponse<Streamer>);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

streamersRouter.post('/:id/stop', (req, res) => {
  const id = req.params.id;
  if (recorderService.isRecording(id)) {
    // 后台异步停止录制(ffmpeg 优雅收尾 + 后处理上传),立即响应前端,避免按钮卡顿
    void recorderService.stop(id, 'manual_stop').catch((e) => {
      console.error('[recorder] stop failed', e);
    });
    res.json({
      ok: true,
      data: { stopped: true },
      message: '已请求停止录制',
    } satisfies ApiResponse);
    return;
  }
  // 无活跃录制(可能进程重启后残留),同步清理数据库状态并立即返回
  const cleaned = recorderService.forceStop(id, 'manual_stop');
  res.json({
    ok: true,
    data: { stopped: cleaned },
    message: cleaned ? '已清理残留录制状态并触发上传' : '当前未在录制',
  } satisfies ApiResponse);
});

streamersRouter.post('/:id/start', async (req, res) => {
  try {
    const s = streamerRepo.get(req.params.id);
    if (!s) {
      res.status(404).json({ ok: false, error: '主播不存在' } satisfies ApiResponse);
      return;
    }
    await monitorService.checkOne(s.id);
    const latest = streamerRepo.get(s.id);
    if (!latest) {
      res.status(404).json({ ok: false, error: '主播不存在' } satisfies ApiResponse);
      return;
    }
    res.json({ ok: true, data: latest } satisfies ApiResponse<Streamer>);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});
