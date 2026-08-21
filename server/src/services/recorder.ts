import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { loadSettings } from '../config.js';
import { fileRepo, streamerRepo } from '../db/index.js';
import type {
  DownloaderType,
  Platform,
  PostProcessTrigger,
  Streamer,
} from '../types.js';
import {
  ensureDir,
  fileSize,
  formatStamp,
  newId,
  nowIso,
  parseDurationToSeconds,
  parseFileSizeToBytes,
  runCommand,
  safeName,
  sleep,
} from '../utils.js';
import {
  fetchPlaylist,
  downloadSegment,
  parsePlaylist,
  getUrlPrefix,
  getStream,
} from '../stripchat/index.js';
import { getMouflonKeys } from '../stripchat/mouflon.js';
import { postProcessService } from './postprocess.js';

export interface ActiveRecording {
  streamerId: string;
  roomId: string;
  streamUrl: string;
  downloader: DownloaderType;
  child: ChildProcess;
  currentFileId: string;
  currentFilePath: string;
  segmentIndex: number;
  startedAt: Date;
  stopReason?: string;
  stopping: boolean;
  /** 文件大小触发切片标记 */
  sizeTriggered?: boolean;
  /** resolve 时表示录制已完全停止(状态已写库) */
  donePromise: Promise<void>;
  resolveDone: () => void;
}

/** Stripchat 分片录制会话 (手动下载分片 + Mouflon 解密 + fMP4 转 TS + ffmpeg 合并) */
interface StripchatSession {
  streamerId: string;
  streamer: Streamer;
  roomId: string;
  streamUrl: string;
  title: string;
  fileId: string;
  filePath: string;
  segmentDir: string;
  segmentIndex: number;
  startedAt: Date;
  stopping: boolean;
  stopReason?: PostProcessTrigger;
  abort: AbortController;
  donePromise: Promise<void>;
  resolveDone: () => void;
  sizeBytes: number;
}

/**
 * FFmpeg 录制:
 * - ffmpeg: 直接拉 flv/hls 写文件,支持 -t 切片
 * - stripchat: 手动下载分片 + Mouflon 解密 + fMP4 转 TS + ffmpeg 合并
 */
export class RecorderService {
  private active = new Map<string, ActiveRecording>();
  /** Stripchat 分片录制会话 */
  private stripchatSessions = new Map<string, StripchatSession>();
  /** 在线但未录制的主播的流地址缓存(用于实时画面快照) */
  private onlineStreamUrls = new Map<string, string>();

  isRecording(streamerId: string) {
    return this.active.has(streamerId) || this.stripchatSessions.has(streamerId);
  }

  /** 缓存在线主播的流地址(供快照端点使用) */
  setOnlineStreamUrl(streamerId: string, url: string) {
    this.onlineStreamUrls.set(streamerId, url);
  }

  /** 清除在线主播的流地址缓存 */
  clearOnlineStreamUrl(streamerId: string) {
    this.onlineStreamUrls.delete(streamerId);
  }

  /** 获取某个主播的直播流地址(录制中优先,否则取在线缓存) */
  getStreamUrl(streamerId: string): string | null {
    const rec = this.active.get(streamerId);
    if (rec) return rec.streamUrl;
    const sc = this.stripchatSessions.get(streamerId);
    if (sc) return sc.streamUrl;
    return this.onlineStreamUrls.get(streamerId) || null;
  }

  listActive() {
    const ffmpeg = Array.from(this.active.values()).map((a) => ({
      streamerId: a.streamerId,
      roomId: a.roomId,
      downloader: a.downloader,
      filePath: a.currentFilePath,
      startedAt: a.startedAt.toISOString(),
      segmentIndex: a.segmentIndex,
    }));
    const sc = Array.from(this.stripchatSessions.values()).map((s) => ({
      streamerId: s.streamerId,
      roomId: s.roomId,
      downloader: 'ffmpeg' as DownloaderType,
      filePath: s.filePath,
      startedAt: s.startedAt.toISOString(),
      segmentIndex: s.segmentIndex,
    }));
    return [...ffmpeg, ...sc];
  }

  getActiveCount() {
    return this.active.size + this.stripchatSessions.size;
  }

  async start(opts: {
    streamer: Streamer;
    roomId: string;
    streamUrl: string;
    title?: string;
  }) {
    const { streamer, roomId, streamUrl } = opts;

    // Stripchat: 走分片下载录制引擎 (Mouflon 解密 + fMP4 转 TS + 合并)
    if (streamer.platform === 'stripchat') {
      return this.startStripchat(opts);
    }

    if (this.active.has(streamer.id)) {
      return this.active.get(streamer.id)!;
    }

    const settings = loadSettings();
    // maxConcurrentRecordings 为 -1 时表示不限制并发录制数
    if (
      settings.maxConcurrentRecordings > 0 &&
      this.active.size >= settings.maxConcurrentRecordings
    ) {
      throw new Error(
        `已达到最大并发录制数 ${settings.maxConcurrentRecordings}`,
      );
    }

    const downloader = this.resolveDownloader(streamer);
    const owner = safeName(streamer.name || 'unknown');
    const dir = path.join(settings.recordingsDir, owner);
    ensureDir(dir);

    const segmentSec = parseDurationToSeconds(settings.segmentDuration);
    const segmentFileSizeBytes = parseFileSizeToBytes(settings.segmentFileSize);
    const session = {
      streamer,
      roomId,
      streamUrl,
      downloader,
      dir,
      title: opts.title || streamer.title || 'live',
      segmentSec,
      segmentFileSizeBytes,
      segmentIndex: 0,
    };

    await this.spawnSegment(session, 'stream_end');
    streamerRepo.update(streamer.id, {
      status: 'recording',
      lastLiveAt: nowIso(),
      lastError: null,
      roomId,
      title: opts.title || streamer.title,
    });
    return this.active.get(streamer.id)!;
  }

  async stop(streamerId: string, reason: PostProcessTrigger = 'manual_stop') {
    const sc = this.stripchatSessions.get(streamerId);
    if (sc) {
      return this.stopStripchat(streamerId, reason);
    }

    const rec = this.active.get(streamerId);
    if (!rec) return false;
    rec.stopping = true;
    rec.stopReason = reason;

    try {
      // 优雅结束
      if (!rec.child.killed) {
        rec.child.kill('SIGINT');
        await new Promise((r) => setTimeout(r, 1500));
        if (!rec.child.killed) rec.child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 1000));
        if (!rec.child.killed) rec.child.kill('SIGKILL');
      }
    } catch {
      // ignore
    }

    // 3s 兜底:万一 close 事件未触发
    const fallbackTimer = setTimeout(() => {
      if (this.active.get(streamerId) === rec) {
        // 兜底也要更新文件状态并触发后处理上传
        const fsize = fileSize(rec.currentFilePath);
        const fExists = fs.existsSync(rec.currentFilePath) && fsize > 1024;
        if (fExists) {
          fileRepo.update(rec.currentFileId, { size: fsize, status: 'ready' });
          postProcessService.enqueue(rec.currentFileId, reason);
        }
        this.finalize(rec, reason);
      }
    }, 3000);

    // 等待 close 事件触发的 finalize(或超时)
    const timeout = new Promise<void>((r) => setTimeout(r, 5000));
    await Promise.race([rec.donePromise, timeout]);
    clearTimeout(fallbackTimer);

    return true;
  }

  async stopAll(reason: PostProcessTrigger = 'manual_stop') {
    const ids = Array.from(this.active.keys());
    for (const id of ids) {
      await this.stop(id, reason);
    }
    const scIds = Array.from(this.stripchatSessions.keys());
    for (const id of scIds) {
      await this.stop(id, reason);
    }
  }

  /**
   * 强制停止单个主播的残留录制状态
   * 用于进程重启后内存 active 为空、但数据库中仍为 recording 的情况
   * 将文件标记为 ready 并触发后处理上传
   */
  forceStop(streamerId: string, reason: PostProcessTrigger = 'manual_stop'): boolean {
    const s = streamerRepo.get(streamerId);
    if (!s) return false;

    let cleaned = false;

    // 更新主播状态
    if (s.status === 'recording') {
      streamerRepo.update(streamerId, { status: 'offline' });
      cleaned = true;
    }

    // 查找该主播所有处于 recording 状态的文件
    const files = fileRepo.list().filter(
      (f) => f.streamerId === streamerId && f.status === 'recording',
    );

    for (const f of files) {
      const size = fileSize(f.absolutePath);
      const exists = fs.existsSync(f.absolutePath) && size > 1024;
      if (exists) {
        fileRepo.update(f.id, { size, status: 'ready' });
        postProcessService.enqueue(f.id, reason);
      } else {
        fileRepo.update(f.id, { status: 'error', error: '录制异常中断,文件无效' });
      }
      cleaned = true;
    }

    if (cleaned) {
      console.log(`[recorder] forceStop streamer=${streamerId} reason=${reason}`);
    }
    return cleaned;
  }

  /**
   * 恢复所有残留的录制状态(用于进程重启后或在线修复)
   * 清理所有处于 recording 状态的主播和文件,触发后处理上传
   */
  recoverOrphanedRecordings(reason: PostProcessTrigger = 'manual_stop'): number {
    let cleaned = 0;

    // 清理所有处于 recording 状态的主播
    const streamers = streamerRepo.list();
    for (const s of streamers) {
      if (s.status === 'recording') {
        streamerRepo.update(s.id, { status: 'offline' });
        cleaned++;
      }
    }

    // 清理所有处于 recording 状态的文件
    const files = fileRepo.list().filter((f) => f.status === 'recording');
    for (const f of files) {
      const size = fileSize(f.absolutePath);
      const exists = fs.existsSync(f.absolutePath) && size > 1024;
      if (exists) {
        fileRepo.update(f.id, { size, status: 'ready' });
        postProcessService.enqueue(f.id, reason);
      } else {
        fileRepo.update(f.id, { status: 'error', error: '录制异常中断,文件无效' });
      }
      cleaned++;
    }

    if (cleaned > 0) {
      console.log(`[recorder] recoverOrphanedRecordings: cleaned=${cleaned} reason=${reason}`);
    }
    return cleaned;
  }

  private resolveDownloader(streamer: Streamer): DownloaderType {
    const settings = loadSettings();
    if (streamer.downloader && streamer.downloader !== 'global') {
      return streamer.downloader;
    }
    return settings.downloader;
  }

  private async spawnSegment(
    session: {
      streamer: Streamer;
      roomId: string;
      streamUrl: string;
      downloader: DownloaderType;
      dir: string;
      title: string;
      segmentSec: number;
      segmentFileSizeBytes: number;
      segmentIndex: number;
    },
    endTrigger: PostProcessTrigger,
  ) {
    const settings = loadSettings();
    const stamp = formatStamp();
    const idx = String(session.segmentIndex).padStart(3, '0');
    const base = `${safeName(session.streamer.name)}_${stamp}_s${idx}`;

    // 统一先落到中间格式,后处理转 mp4
    let ext = 'flv';
    if (session.downloader === 'ffmpeg') {
      // 开启自动转码 MP4 → 直接录制为 mp4(省去后处理转码步骤)
      // 关闭自动转码 MP4 → 录制为 ts(保留原始流,不转码)
      ext = settings.autoTranscode ? 'mp4' : 'ts';
    }
    const filename = `${base}.${ext}`;
    const filePath = path.join(session.dir, filename);
    const fileId = newId('file');
    const rel = path
      .relative(settings.recordingsDir, filePath)
      .replace(/\\/g, '/');

    fileRepo.create({
      id: fileId,
      streamerId: session.streamer.id,
      streamerName: session.streamer.name,
      filename,
      relativePath: rel,
      absolutePath: filePath,
      size: 0,
      durationSec: null,
      format: ext,
      status: 'recording',
      uploadTool: null,
      uploadMode: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      uploadedAt: null,
      remotePath: null,
      error: null,
    });

    const { child, engine } = this.spawnEngine({
      downloader: session.downloader,
      streamUrl: session.streamUrl,
      filePath,
      segmentSec: session.segmentSec,
      roomId: session.roomId,
      platform: session.streamer.platform,
      settings,
    });

    let resolveDone: () => void = () => {};
    const donePromise = new Promise<void>((r) => { resolveDone = r; });

    const rec: ActiveRecording = {
      streamerId: session.streamer.id,
      roomId: session.roomId,
      streamUrl: session.streamUrl,
      downloader: engine,
      child,
      currentFileId: fileId,
      currentFilePath: filePath,
      segmentIndex: session.segmentIndex,
      startedAt: new Date(),
      stopping: false,
      donePromise,
      resolveDone,
    };
    this.active.set(session.streamer.id, rec);

    // 录制中定时更新文件大小到数据库(每 5 秒)
    const sizeUpdateTimer = setInterval(() => {
      try {
        if (fs.existsSync(filePath)) {
          const size = fs.statSync(filePath).size;
          fileRepo.update(fileId, { size });

          // 切片文件大小检查:当设置了切片文件大小时,无论是否设置了切片时长都生效
          // 切片时长与切片文件大小可以同时设置,先达到阈值的先触发切片
          if (
            session.segmentFileSizeBytes > 0 &&
            size >= session.segmentFileSizeBytes &&
            !rec.stopping &&
            !rec.sizeTriggered
          ) {
            console.log(
              `[recorder] 文件大小 ${size} 达到切片阈值 ${session.segmentFileSizeBytes},触发切片`,
            );
            rec.sizeTriggered = true;
            // 发送 SIGINT 让 ffmpeg 正常结束,触发 close 事件
            try { rec.child.kill('SIGINT'); } catch { /* ignore */ }
          }
        }
      } catch {
        // ignore
      }
    }, 5000);

    child.on('close', async (code) => {
      clearInterval(sizeUpdateTimer);
      const current = this.active.get(session.streamer.id);
      if (!current || current.currentFileId !== fileId) return;

      const size = fileSize(filePath);
      const existed = fs.existsSync(filePath) && size > 1024;

      // 检查实际录制时长,防止流中断导致提前切片
      const elapsedSec = (Date.now() - current.startedAt.getTime()) / 1000;
      const isRealSegment =
        (session.segmentSec > 0 &&
          code === 0 &&
          elapsedSec >= session.segmentSec * 0.8) ||
        (current.sizeTriggered && existed);

      if (existed) {
        fileRepo.update(fileId, {
          size,
          status: 'ready',
        });
        // 切片完成触发后处理
        const trigger: PostProcessTrigger = current.stopping
          ? (current.stopReason as PostProcessTrigger) || 'manual_stop'
          : isRealSegment
            ? 'segment'
            : endTrigger;
        postProcessService.enqueue(fileId, trigger);
      } else {
        // 文件可能因 move 模式已被删除,这种情况下不报错
        const stillExists = fs.existsSync(filePath);
        if (stillExists) {
          fileRepo.update(fileId, {
            status: 'error',
            error: `录制结束但文件无效 code=${code}`,
            size,
          });
        } else {
          fileRepo.update(fileId, {
            status: 'uploaded',
            size: 0,
            error: null,
            absolutePath: '',
          });
        }
      }

      // 若非主动停止且仍应继续(切片或异常重启由 monitor 处理)
      if (
        !current.stopping &&
        isRealSegment &&
        existed
      ) {
        // 自动下一段
        session.segmentIndex += 1;
        try {
          await this.spawnSegment(session, 'stream_end');
          return;
        } catch (e) {
          console.error('[recorder] next segment failed', e);
        }
      }

      this.finalize(current, current.stopReason as PostProcessTrigger || 'stream_end');
    });
  }

  private finalize(rec: ActiveRecording, reason: PostProcessTrigger) {
    this.active.delete(rec.streamerId);
    const s = streamerRepo.get(rec.streamerId);
    if (s && s.status === 'recording') {
      streamerRepo.update(rec.streamerId, {
        status: 'offline',
      });
    }
    rec.resolveDone();
    console.log(
      `[recorder] finalize streamer=${rec.streamerId} reason=${reason}`,
    );
  }

  /* ============================================================
     Stripchat 分片录制引擎
     移植自 StripchatRecorder 的 recording_loop + merge_segments:
     下载变体 m3u8 → parse_playlist(Mouflon 解密) → 下载分片
     → fMP4 转 TS → 录制结束 ffmpeg concat 合并为 mp4/ts
     ============================================================ */

  private async startStripchat(opts: {
    streamer: Streamer;
    roomId: string;
    streamUrl: string;
    title?: string;
  }): Promise<StripchatSession> {
    const { streamer, roomId, streamUrl } = opts;
    if (this.stripchatSessions.has(streamer.id)) {
      return this.stripchatSessions.get(streamer.id)!;
    }

    const settings = loadSettings();
    if (
      settings.maxConcurrentRecordings > 0 &&
      this.getActiveCount() >= settings.maxConcurrentRecordings
    ) {
      throw new Error(`已达到最大并发录制数 ${settings.maxConcurrentRecordings}`);
    }

    const abort = new AbortController();
    let resolveDone: () => void = () => {};
    const donePromise = new Promise<void>((r) => {
      resolveDone = r;
    });

    const session: StripchatSession = {
      streamerId: streamer.id,
      streamer,
      roomId,
      streamUrl,
      title: opts.title || streamer.title || 'live',
      fileId: '',
      filePath: '',
      segmentDir: '',
      segmentIndex: 0,
      startedAt: new Date(),
      stopping: false,
      abort,
      donePromise,
      resolveDone,
      sizeBytes: 0,
    };

    // 创建第一个录制段 (文件 + 分片临时目录)
    const first = this.createStripchatSegmentFile(session);
    session.fileId = first.fileId;
    session.filePath = first.filePath;
    session.segmentDir = first.segmentDir;

    this.stripchatSessions.set(streamer.id, session);

    streamerRepo.update(streamer.id, {
      status: 'recording',
      lastLiveAt: nowIso(),
      lastError: null,
      roomId,
      title: opts.title || streamer.title,
    });

    // 后台启动下载循环
    void this.runStripchatLoop(session);

    return session;
  }

  /** 创建 Stripchat 录制段 (写入 files 表 + 创建分片临时目录) */
  private createStripchatSegmentFile(session: StripchatSession): {
    fileId: string;
    filePath: string;
    segmentDir: string;
  } {
    const settings = loadSettings();
    const owner = safeName(session.streamer.name || 'unknown');
    const dir = path.join(settings.recordingsDir, owner);
    ensureDir(dir);

    const stamp = formatStamp();
    const idx = String(session.segmentIndex).padStart(3, '0');
    const base = `${safeName(session.streamer.name)}_${stamp}_s${idx}`;
    const ext = settings.autoTranscode ? 'mp4' : 'ts';
    const filename = `${base}.${ext}`;
    const filePath = path.join(dir, filename);
    const fileId = newId('file');
    const rel = path
      .relative(settings.recordingsDir, filePath)
      .replace(/\\/g, '/');

    // 分片临时目录(隐藏目录, 录完删除; syncFilesFromDisk 跳过隐藏目录)
    const segmentDir = path.join(dir, `.${base}_segments`);
    ensureDir(segmentDir);

    fileRepo.create({
      id: fileId,
      streamerId: session.streamer.id,
      streamerName: session.streamer.name,
      filename,
      relativePath: rel,
      absolutePath: filePath,
      size: 0,
      durationSec: null,
      format: ext,
      status: 'recording',
      uploadTool: null,
      uploadMode: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      uploadedAt: null,
      remotePath: null,
      error: null,
    });

    return { fileId, filePath, segmentDir };
  }

  private async stopStripchat(
    streamerId: string,
    reason: PostProcessTrigger = 'manual_stop',
  ): Promise<boolean> {
    const session = this.stripchatSessions.get(streamerId);
    if (!session) return false;
    session.stopping = true;
    session.stopReason = reason;
    session.abort.abort();
    // 等待下载循环退出 + 合并完成
    await session.donePromise;
    return true;
  }

  /** 下载循环: 持续拉取播放列表, 下载新分片并转 TS, 支持时长/文件大小切片 */
  private async runStripchatLoop(session: StripchatSession) {
    const username = session.roomId;
    const { streamer, abort } = session;
    let currentPlaylistUrl = session.streamUrl;
    let urlPrefix = getUrlPrefix(currentPlaylistUrl);

    // 段级状态 (切片时重置)
    let downloadedSequences = new Set<number>();
    let mp4Header: Buffer | null = null;
    let cachedInitUrl: string | null = null;
    let segmentStartedAt = Date.now();

    let retryCount = 0;
    let playlistRefreshFailures = 0;
    let consecutiveCdnFailures = 0;
    const MAX_RETRIES = 10;
    const MAX_PLAYLIST_REFRESH_FAILURES = 5;
    const CDN_FAILURE_REFRESH_THRESHOLD = 3;

    const initSettings = loadSettings();
    const segmentSec = parseDurationToSeconds(initSettings.segmentDuration);
    const segmentFileSizeBytes = parseFileSizeToBytes(initSettings.segmentFileSize);

    console.log(
      `[stripchat] 开始录制 ${username} → ${session.segmentDir}` +
        ` (切片: 时长=${initSettings.segmentDuration || '关'} 大小=${initSettings.segmentFileSize || '关'})`,
    );

    while (!abort.signal.aborted) {
      const settings = loadSettings();
      const cookie = (settings.cookieStripchat || settings.cookie || '').replace(/[\r\n]+/g, '');
      try {
        const playlist = await fetchPlaylist(currentPlaylistUrl, cookie || undefined);
        const { segments, initUrl } = parsePlaylist(
          playlist,
          urlPrefix,
          getMouflonKeys(),
        );

        // 下载 fMP4 init 段
        if (initUrl && initUrl !== cachedInitUrl) {
          try {
            mp4Header = await downloadSegment(initUrl, cookie || undefined);
            cachedInitUrl = initUrl;
          } catch (e) {
            console.warn(`[stripchat] init 段下载失败 ${username}:`, e instanceof Error ? e.message : e);
          }
        }

        let written = 0;
        let cdnFail = 0;
        for (const segUrl of segments) {
          if (abort.signal.aborted) break;
          const seq = extractSequence(segUrl);
          if (seq !== null && downloadedSequences.has(seq)) continue;
          try {
            const bytes = await downloadSegment(segUrl, cookie || undefined);
            // fMP4 分片 = init 段 + media 段
            const full = mp4Header ? Buffer.concat([mp4Header, bytes]) : bytes;
            const tsName = `${String(seq ?? downloadedSequences.size).padStart(8, '0')}.ts`;
            const tsPath = path.join(session.segmentDir, tsName);
            const ok = await this.convertFmp4ToTs(full, tsPath, streamer.name);
            if (ok) {
              if (seq !== null) downloadedSequences.add(seq);
              written++;
              session.sizeBytes = dirSize(session.segmentDir);
              fileRepo.update(session.fileId, { size: session.sizeBytes });
            } else {
              cdnFail++;
            }
          } catch (e) {
            cdnFail++;
            console.warn(`[stripchat] 分片下载失败 ${username}:`, e instanceof Error ? e.message : e);
          }
        }

        if (written > 0) {
          consecutiveCdnFailures = 0;
          retryCount = 0;
        } else {
          retryCount++;
        }
        if (cdnFail > 0) consecutiveCdnFailures += cdnFail;

        // 连续 CDN 失败 → 刷新播放列表 URL
        if (consecutiveCdnFailures >= CDN_FAILURE_REFRESH_THRESHOLD) {
          consecutiveCdnFailures = 0;
          const newUrl = await this.refreshStripchatPlaylist(streamer, username);
          if (newUrl) {
            currentPlaylistUrl = newUrl;
            urlPrefix = getUrlPrefix(newUrl);
            playlistRefreshFailures = 0;
            retryCount = 0;
          } else {
            playlistRefreshFailures++;
          }
          if (playlistRefreshFailures >= MAX_PLAYLIST_REFRESH_FAILURES) {
            console.warn(`[stripchat] 流结束 → ${username} (播放列表刷新失败 ${playlistRefreshFailures} 次)`);
            break;
          }
        }

        if (retryCount >= MAX_RETRIES) {
          console.warn(`[stripchat] 流结束 → ${username} (max retries)`);
          break;
        }

        // 切片检查 (仅在非停止状态下触发; 停止时交给最终收尾)
        if (!session.stopping && written > 0) {
          const elapsedSec = (Date.now() - segmentStartedAt) / 1000;
          const sizeBytes = dirSize(session.segmentDir);
          const hitDuration = segmentSec > 0 && elapsedSec >= segmentSec;
          const hitSize =
            segmentFileSizeBytes > 0 && sizeBytes >= segmentFileSizeBytes;

          if (hitDuration || hitSize) {
            console.log(
              `[stripchat] 触发切片 ${username}: ` +
                `时长=${elapsedSec.toFixed(0)}s/${segmentSec}s ` +
                `大小=${sizeBytes}/${segmentFileSizeBytes}B`,
            );
            await this.rotateStripchatSegment(session);
            // 重置段级状态
            downloadedSequences = new Set<number>();
            mp4Header = null;
            cachedInitUrl = null;
            segmentStartedAt = Date.now();
            retryCount = 0;
            consecutiveCdnFailures = 0;

            // 切片后刷新播放列表, 新段从最新流开始
            const newUrl = await this.refreshStripchatPlaylist(streamer, username);
            if (newUrl) {
              currentPlaylistUrl = newUrl;
              urlPrefix = getUrlPrefix(newUrl);
              playlistRefreshFailures = 0;
            }
          }
        }

        await sleep(1500);
      } catch (e) {
        console.error(`[stripchat] 拉流失败 ${username}:`, e instanceof Error ? e.message : e);
        retryCount++;
        if (retryCount >= MAX_RETRIES) break;
        await sleep(1500);
      }
    }

    await this.finishStripchatRecording(session);
  }

  /** 重新获取变体播放列表 URL (流中断时刷新) */
  private async refreshStripchatPlaylist(
    streamer: Streamer,
    username: string,
  ): Promise<string | null> {
    try {
      const settings = loadSettings();
      const cookie = (settings.cookieStripchat || settings.cookie || '').replace(/[\r\n]+/g, '');
      const stream = await getStream({
        username,
        quality: streamer.recordQuality || 'OD',
        cookie: cookie || undefined,
        mouflonKeys: getMouflonKeys(),
      });
      return stream.url || null;
    } catch (e) {
      console.warn(`[stripchat] 刷新播放列表失败 ${username}:`, e instanceof Error ? e.message : e);
      return null;
    }
  }

  /** fMP4 分片 (init + media) 转 TS (支持 H264/HEVC/AV1 Annex B 转换) */
  private async convertFmp4ToTs(
    bytes: Buffer,
    tsPath: string,
    streamerName: string,
  ): Promise<boolean> {
    const settings = loadSettings();
    const tmpMp4 = `${tsPath}.mp4`;
    try {
      fs.writeFileSync(tmpMp4, bytes);
    } catch (e) {
      console.error(`[stripchat] 写临时分片失败 ${streamerName}:`, e instanceof Error ? e.message : e);
      return false;
    }

    const bsfVariants: string[][] = [
      ['-bsf:v', 'h264_mp4toannexb'],
      ['-bsf:v', 'hevc_mp4toannexb'],
      ['-bsf:v', 'av1_mp4toannexb'],
      [],
    ];

    try {
      for (const bsf of bsfVariants) {
        const args = [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', tmpMp4,
          '-c', 'copy',
          ...bsf,
          '-f', 'mpegts',
          tsPath,
        ];
        try {
          const { done } = runCommand(settings.ffmpegPath, args, {});
          const r = await done;
          if (r.code === 0 && fs.existsSync(tsPath) && fs.statSync(tsPath).size > 0) {
            return true;
          }
        } catch (e) {
          console.warn(`[stripchat] fMP4 转 TS 失败 ${streamerName}:`, e instanceof Error ? e.message : e);
        }
        try { fs.unlinkSync(tsPath); } catch { /* ignore */ }
      }
      return false;
    } finally {
      try { fs.unlinkSync(tmpMp4); } catch { /* ignore */ }
    }
  }

  /** 合并会话目录下所有 TS 分片为最终视频 */
  private async mergeTsSegments(session: StripchatSession): Promise<boolean> {
    const settings = loadSettings();
    let tsFiles: string[] = [];
    try {
      tsFiles = fs
        .readdirSync(session.segmentDir)
        .filter((f) => f.endsWith('.ts'))
        .sort();
    } catch {
      return false;
    }
    if (tsFiles.length === 0) return false;

    const listPath = path.join(session.segmentDir, 'list.txt');
    const listContent = tsFiles
      .map((f) => `file '${path.join(session.segmentDir, f)}'`)
      .join('\n');
    try {
      fs.writeFileSync(listPath, listContent, 'utf8');
    } catch {
      return false;
    }

    // 输出 mp4 时需将 TS 中的 AAC(ADTS) 转为 MP4 的 AAC(ASC)
    const bsfVariants: string[][] = session.filePath.endsWith('.mp4')
      ? [['-bsf:a', 'aac_adtstoasc'], []]
      : [[]];

    try {
      for (const bsf of bsfVariants) {
        const args = [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'concat', '-safe', '0',
          '-i', listPath,
          '-c', 'copy',
          ...bsf,
        ];
        if (session.filePath.endsWith('.mp4')) {
          args.push('-movflags', '+faststart');
        }
        args.push(session.filePath);
        try {
          const { done } = runCommand(settings.ffmpegPath, args, {});
          const r = await done;
          if (
            r.code === 0 &&
            fs.existsSync(session.filePath) &&
            fs.statSync(session.filePath).size > 1024
          ) {
            return true;
          }
        } catch (e) {
          console.warn(`[stripchat] 合并失败 ${session.streamerId}:`, e instanceof Error ? e.message : e);
        }
        try { fs.unlinkSync(session.filePath); } catch { /* ignore */ }
      }
      return false;
    } finally {
      try { fs.unlinkSync(listPath); } catch { /* ignore */ }
    }
  }

  /** 录制结束: 合并最后一段, 更新文件状态, 触发后处理, 清理, 关闭会话 */
  private async finishStripchatRecording(session: StripchatSession) {
    if (!this.stripchatSessions.has(session.streamerId)) return;

    const reason: PostProcessTrigger = session.stopReason || 'stream_end';
    await this.finalizeStripchatSegment(session, reason);

    this.stripchatSessions.delete(session.streamerId);
    const s = streamerRepo.get(session.streamerId);
    if (s && s.status === 'recording') {
      streamerRepo.update(session.streamerId, { status: 'offline' });
    }
    session.resolveDone();
    console.log(`[stripchat] finalize ${session.streamerId} reason=${reason}`);
  }

  /** 合并当前段的 TS 分片为最终视频, 更新文件状态并触发后处理 */
  private async finalizeStripchatSegment(
    session: StripchatSession,
    trigger: PostProcessTrigger,
  ): Promise<boolean> {
    const merged = await this.mergeTsSegments(session);
    const size = fileSize(session.filePath);
    const existed = merged && size > 1024;

    if (existed) {
      fileRepo.update(session.fileId, { size, status: 'ready' });
      postProcessService.enqueue(session.fileId, trigger);
    } else {
      fileRepo.update(session.fileId, {
        status: 'error',
        error: '录制结束但无有效分片',
        size,
      });
    }

    // 清理临时分片目录
    try {
      fs.rmSync(session.segmentDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    return existed;
  }

  /** 切片: 结束当前段并创建新段 */
  private async rotateStripchatSegment(session: StripchatSession): Promise<void> {
    // 结束当前段并触发切片后处理
    await this.finalizeStripchatSegment(session, 'segment');
    // 创建新段
    session.segmentIndex += 1;
    const next = this.createStripchatSegmentFile(session);
    session.fileId = next.fileId;
    session.filePath = next.filePath;
    session.segmentDir = next.segmentDir;
    session.sizeBytes = 0;
    console.log(`[stripchat] 已切片 → ${session.streamerId} 段 ${session.segmentIndex}`);
  }

  private spawnEngine(opts: {
    downloader: DownloaderType;
    streamUrl: string;
    filePath: string;
    segmentSec: number;
    roomId: string;
    platform: Platform;
    settings: ReturnType<typeof loadSettings>;
  }): { child: ChildProcess; engine: DownloaderType } {
    const { streamUrl, filePath, segmentSec, platform, settings } = opts;

    const trySpawn = (type: DownloaderType): ChildProcess | null => {
      try {
        if (type === 'ffmpeg') {
          const args = [
            '-y',
            '-hide_banner',
            '-loglevel',
            'warning',
            '-rw_timeout',
            '10000000',
            '-timeout',
            '10000000',
          ];

          // 仅 Pandalive:其流地址(尤其成人/登录保护的流)需要携带会话 Cookie
          // 与 Referer/Origin/UA 校验,否则 FFmpeg 裸拉会 403 或空流。
          // 仅在此分支注入 headers,不影响其他平台带签名 token 的流地址。
          if (platform === 'pandalive') {
            const cookie = (settings.cookiePandalive || settings.cookie || '')
              .replace(/[\r\n]+/g, '');
            const headerLines = [
              'Referer: https://www.pandalive.co.kr/',
              'Origin: https://www.pandalive.co.kr',
              'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
            ];
            if (cookie) {
              headerLines.push(`Cookie: ${cookie}`);
            }
            args.push('-headers', `${headerLines.join('\r\n')}\r\n`);
          }

          // Stripchat:CDN HLS 分片需要携带 Referer 与浏览器 UA 校验,
          // 否则 FFmpeg 裸拉会 403。Cookie 可选(公开秀无需登录)。
          if (platform === 'stripchat') {
            const cookie = (settings.cookieStripchat || settings.cookie || '')
              .replace(/[\r\n]+/g, '');
            const headerLines = [
              'Referer: https://stripchat.com/',
              'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
            ];
            if (cookie) {
              headerLines.push(`Cookie: ${cookie}`);
            }
            args.push('-headers', `${headerLines.join('\r\n')}\r\n`);
          }

          args.push('-i', streamUrl, '-c', 'copy');
          if (segmentSec > 0) {
            args.push('-t', String(segmentSec));
          }
          // ts/mp4
          if (filePath.endsWith('.mp4')) {
            args.push('-movflags', '+faststart');
          }
          args.push(filePath);
          const { child } = runCommand(settings.ffmpegPath, args, {
            onStderr: (l) => console.log(`[ffmpeg:${opts.roomId}] ${l}`),
          });
          return child;
        }
      } catch (e) {
        console.error(`[recorder] spawn ${type} failed`, e);
      }
      return null;
    };

    const child = trySpawn('ffmpeg');
    if (!child) {
      throw new Error('无法启动任何录制引擎');
    }
    return { child, engine: 'ffmpeg' };
  }
}

/** 递归计算目录大小 (字节) */
function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) total += dirSize(abs);
      else total += st.size;
    }
  } catch {
    // ignore
  }
  return total;
}

/**
 * 从分片 URL 文件名提取序号 (最后一个 _ 后、. 前的数字)。
 * 与 StripchatRecorder hls.rs 的 extract_sequence 一致。
 */
function extractSequence(url: string): number | null {
  const pathPart = url.split('?')[0];
  const filename = pathPart.split('/').pop() ?? '';
  const parts = filename.split('_');
  const last = parts[parts.length - 1] ?? '';
  const numStr = last.split('.')[0] ?? '';
  if (!/^\d+$/.test(numStr)) return null;
  const n = parseInt(numStr, 10);
  return Number.isFinite(n) ? n : null;
}

export const recorderService = new RecorderService();
