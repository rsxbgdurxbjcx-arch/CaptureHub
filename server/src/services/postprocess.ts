import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PATHS, loadSettings } from '../config.js';
import {
  fileRepo,
  jobRepo,
  streamerRepo,
  markPathPendingDelete,
  isPathPendingDelete,
} from '../db/index.js';
import type { PostProcessTrigger, RecordingFile, Settings } from '../types.js';
import {
  ensureDir,
  getDiskFreeBytes,
  newId,
  nowIso,
  runCommand,
  safeName,
  sleep,
} from '../utils.js';
import { grammyService, generateTags } from './grammy.js';

/**
 * 后处理:转码(可选) + 执行脚本(默认 rclone 上传到 pikpak:red/主播名/)
 * 支持最大并发上传数控制
 */

/** 上传进度信息(内存中实时跟踪,供前端轮询展示) */
export interface UploadProgress {
  fileId: string;
  progress: number;      // 0-100
  speed: number;         // bytes per second
  uploadedBytes: number; // 已上传字节
  totalBytes: number;    // 总字节
  phase: 'transcoding' | 'uploading' | 'finalizing';
  startedAt: number;     // 开始时间戳
}

/** 解析 rclone 进度行,提取已传输/总量/百分比/速度 */
function parseRcloneProgressLine(line: string): {
  progress: number;
  speed: number;
  uploadedBytes: number;
  totalBytes: number;
} | null {
  // rclone --stats-one-line 输出格式:
  // Transferred:   	1.234 GiB / 10.000 GiB, 12%, 2.345 MiB/s, ETA 37m30s
  const m = line.match(
    /Transferred:\s+([\d.]+\s*[KMGTP]?i?B)\s*\/\s*([\d.]+\s*[KMGTP]?i?B),\s*(\d+)%,\s*([\d.]+\s*[KMGTP]?i?B\/s)/i,
  );
  if (!m) return null;
  return {
    progress: parseInt(m[3], 10),
    speed: parseSizeStr(m[4]),
    uploadedBytes: parseSizeStr(m[1]),
    totalBytes: parseSizeStr(m[2]),
  };
}

/** 将 "1.23 GiB" / "456 MiB/s" 等字符串转为字节数 */
function parseSizeStr(s: string): number {
  const m = s.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB|PiB|KB|MB|GB|TB|PB)/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult: Record<string, number> = {
    b: 1,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
  };
  return num * (mult[unit] || 1);
}

/** 后处理失败自动重试上限(超时/网络/限流等错误;FloodWait 已在 grammy 内处理) */
const POSTPROCESS_MAX_RETRY = 3;
/** 失败重试退避延迟基数(秒),第 n 次重试延迟 = BASE * 2^(n-1) */
const POSTPROCESS_RETRY_BASE_DELAY_SEC = 60;

/** 队列任务项(attempt = 已尝试次数,用于失败自动重试) */
interface QueueItem {
  fileId: string;
  trigger: PostProcessTrigger;
  attempt: number;
}

export class PostProcessService {
  private queue: QueueItem[] = [];
  private activeCount = 0;
  /** 上传进度跟踪(fileId → 进度信息) */
  private progressMap = new Map<string, UploadProgress>();
  /** 进度实时推送事件源(SSE) */
  private emitter = new EventEmitter();

  /** 获取单个文件的上传进度 */
  getProgress(fileId: string): UploadProgress | null {
    return this.progressMap.get(fileId) || null;
  }

  /** 获取所有正在处理的文件的上传进度 */
  getAllProgress(): Record<string, UploadProgress> {
    const result: Record<string, UploadProgress> = {};
    for (const [id, p] of this.progressMap) {
      result[id] = p;
    }
    return result;
  }

  /** 当前所有进度快照(供 SSE 新连接初始化) */
  getProgressSnapshot(): UploadProgress[] {
    return Array.from(this.progressMap.values());
  }

  /** 订阅实时进度推送,返回取消订阅函数 */
  subscribe(listener: (p: UploadProgress) => void): () => void {
    this.emitter.on('progress', listener);
    return () => this.emitter.off('progress', listener);
  }

  /** 设置/更新上传进度,并实时广播给所有 SSE 订阅者 */
  private setProgress(fileId: string, patch: Partial<UploadProgress>) {
    const existing = this.progressMap.get(fileId);
    let next: UploadProgress;
    if (existing) {
      next = { ...existing, ...patch };
      this.progressMap.set(fileId, next);
    } else {
      next = {
        fileId,
        progress: 0,
        speed: 0,
        uploadedBytes: 0,
        totalBytes: 0,
        phase: 'uploading',
        startedAt: Date.now(),
        ...patch,
      };
      this.progressMap.set(fileId, next);
    }
    // 实时推送
    this.emitter.emit('progress', next);
  }

  /** 清除上传进度 */
  private clearProgress(fileId: string) {
    this.progressMap.delete(fileId);
  }

  enqueue(fileId: string, trigger: PostProcessTrigger, attempt = 0) {
    this.queue.push({ fileId, trigger, attempt });
    void this.pump();
  }

  /**
   * 丢弃指定文件的排队任务与进度跟踪(删除主播/文件时调用),
   * 防止文件删除后队列中的任务再把已删文件上传/登记。
   * 已处于执行中的任务无法中止,但会因文件不存在而安全失败。
   */
  discard(fileIds: string[]) {
    const ids = new Set(fileIds);
    if (ids.size === 0) return;
    this.queue = this.queue.filter((item) => !item.fileId || !ids.has(item.fileId));
    for (const id of ids) {
      this.clearProgress(id);
    }
  }

  async runNow(fileId: string, trigger: PostProcessTrigger = 'manual') {
    return this.execute(fileId, trigger);
  }

  private getMaxConcurrent(): number {
    const s = loadSettings();
    // grammY 与 rclone 完全独立并发:
    // grammY 使用 grammyMaxConcurrentUploads, rclone 使用 maxConcurrentUploads
    if (s.uploadTool === 'grammy') {
      const max = s.grammyMaxConcurrentUploads || 1;
      return Math.max(1, max);
    }
    const max = s.maxConcurrentUploads || 3;
    return Math.max(1, max);
  }

  private async pump() {
    // 并发调度:只要队列有任务且未达到并发上限,就启动新任务
    while (this.queue.length > 0 && this.activeCount < this.getMaxConcurrent()) {
      const item = this.queue.shift()!;
      this.activeCount++;
      void this.execute(item.fileId, item.trigger, item.attempt)
        .catch((e) => console.error('[postprocess]', e))
        .finally(() => {
          this.activeCount--;
          void this.pump();
        });
    }
  }

  private shouldRun(trigger: PostProcessTrigger): boolean {
    const s = loadSettings();
    if (trigger === 'manual') return true;
    if (trigger === 'stream_end') return s.postProcessOnStreamEnd;
    if (trigger === 'manual_stop') return s.postProcessOnManualStop;
    if (trigger === 'segment') return s.postProcessOnSegment;
    return false;
  }

  private async execute(fileId: string, trigger: PostProcessTrigger, attempt = 0) {
    if (!this.shouldRun(trigger)) {
      return { skipped: true };
    }

    const file = fileRepo.get(fileId);
    if (!file) throw new Error(`文件不存在: ${fileId}`);
    // 后端状态守卫:正在录制的文件不可上传;处理中的文件防止并发重复执行(转码竞态/重复上传)
    if (file.status === 'recording') {
      throw new Error('文件正在录制中,无法上传');
    }
    if (file.status === 'processing') {
      throw new Error('文件正在处理中,请稍候');
    }
    // 已上传(含 copy 模式保留本地副本)的文件禁止重复上传:
    // 防止"失败自动重试定时器"与"用户手动上传"竞态造成 Telegram 重复视频
    if (file.status === 'uploaded') {
      throw new Error('文件已上传,无需重复上传');
    }
    if (!fs.existsSync(file.absolutePath)) {
      throw new Error(`本地文件丢失: ${file.absolutePath}`);
    }

    const settings = loadSettings();
    // 兜底与默认一致:未配置时为 grammY
    const uploadTool = settings.uploadTool || 'grammy';
    const uploadMode = uploadTool === 'grammy' ? settings.grammyMode : settings.rcloneMode;
    const jobId = newId('job');
    const job = {
      id: jobId,
      trigger,
      fileId: file.id,
      streamerName: file.streamerName,
      filename: file.filename,
      status: 'running' as const,
      log: '',
      createdAt: nowIso(),
      finishedAt: null as string | null,
      uploadTool,
      uploadMode,
    };
    jobRepo.create(job);

    // 记录上传工具和模式
    fileRepo.update(file.id, {
      status: 'processing',
      uploadTool,
      uploadMode,
    });

    // 初始化进度跟踪
    const totalBytes = file.size || (fs.existsSync(file.absolutePath) ? fs.statSync(file.absolutePath).size : 0);
    this.setProgress(file.id, {
      progress: 0,
      speed: 0,
      uploadedBytes: 0,
      totalBytes,
      phase: 'transcoding',
      startedAt: Date.now(),
    });

    let log = '';
    const append = (line: string) => {
      log += line + '\n';
      // 日志写库失败(磁盘满/SQLITE_FULL 等)不应中断上传主流程:
      // 此时仅保留内存日志与终端输出,避免"日志写不进 → 上传流程崩溃 → 更严重故障"
      try {
        jobRepo.update(jobId, { log });
      } catch (e) {
        console.error('[postprocess] 任务日志写库失败(不影响上传):', e instanceof Error ? e.message : e);
      }
    };

    try {
      let workFile = file;

      // 自动转码为 mp4(非 mp4 一律转码;原 ts 分支被前一条件覆盖,属死代码,已移除)
      if (settings.autoTranscode && !file.filename.toLowerCase().endsWith('.mp4')) {
        // 磁盘空间守卫:转码产物≈源文件大小,需与源文件同时存在;
        // 不足时跳过转码直接上传源文件,避免"磁盘满→转码失败→任务永远卡死"
        const srcBytes =
          file.size ||
          (fs.existsSync(file.absolutePath) ? fs.statSync(file.absolutePath).size : 0);
        const freeBytes = getDiskFreeBytes(path.dirname(file.absolutePath));
        if (freeBytes < srcBytes * 1.5 + 256 * 1024 * 1024) {
          append(
            `[transcode] 磁盘空间不足(可用 ${Math.round(freeBytes / 1024 / 1024)} MB,` +
              `需要约 ${Math.round((srcBytes * 1.5 + 256 * 1024 * 1024) / 1024 / 1024)} MB),` +
              `跳过转码,直接上传源文件(若 Telegram 拒绝该格式,请清理空间后重新上传)`,
          );
        } else {
          append(`[transcode] 开始转码 -> mp4`);
          workFile = await this.transcodeToMp4(file, settings.ffmpegPath, append);
        }
      } else {
        append(`[transcode] 跳过(已是 mp4 或未开启自动转码)`);
      }

      // 根据上传工具选择上传路径
      this.setProgress(workFile.id, { phase: 'uploading', progress: 0 });
      if (uploadTool === 'grammy') {
        await this.executeGrammyUpload(workFile, settings, trigger, append);
      } else {
        await this.executeRcloneUpload(workFile, settings, trigger, append, jobId);
      }

      this.setProgress(workFile.id, { phase: 'finalizing', progress: 100, speed: 0 });

      // move 模式:上传完成 → 删除本地文件 + 无条件删除文件记录(卡片随文件一起消失)
      const isMoveMode =
        (uploadTool === 'grammy' && settings.grammyMode === 'move') ||
        (uploadTool === 'rclone' && settings.rcloneMode === 'move');

      let deletedLocal = false;
      let deleteFailed = '';
      if (isMoveMode) {
        // 删除本地物理文件(带重试,确保真正删除;rclone/grammy move 可能已删)
        if (workFile.absolutePath && fs.existsSync(workFile.absolutePath)) {
          let unlinked = false;
          for (let i = 0; i < 5 && !unlinked; i++) {
            try {
              fs.unlinkSync(workFile.absolutePath);
              unlinked = true;
            } catch (e) {
              if (i < 4) {
                await sleep(300);
              } else {
                const msg = e instanceof Error ? e.message : String(e);
                deleteFailed = msg;
                append(`[cleanup] 删除本地文件失败(重试后仍失败): ${msg}`);
              }
            }
          }
          if (unlinked) {
            append(`[cleanup] ${uploadTool}·move 已删除本地文件`);
            deletedLocal = true;
          }
        }
        // 登记"待删除"墓碑:即使物理文件删除稍慢/失败(如被占用),
        // 磁盘同步 syncFilesFromDisk 也不会把该文件重新登记成幽灵卡片
        if (workFile.absolutePath) {
          markPathPendingDelete(workFile.absolutePath);
        }
        append(`[cleanup] ${uploadTool}·move 上传完成,删除文件记录`);
        fileRepo.remove(workFile.id);
        // 清理指向同一本地文件的残留记录:防止磁盘同步在转码期间
        // 生成重复记录,导致上传完成后残留"幽灵"卡片
        for (const dup of fileRepo.list()) {
          if (
            dup.id !== workFile.id &&
            dup.absolutePath &&
            dup.absolutePath === workFile.absolutePath
          ) {
            fileRepo.remove(dup.id);
          }
        }
        deletedLocal = true;
        // 上传成功但物理文件未能删除:发出醒目警告,提示手工清理,
        // 否则该文件将成为不占卡片、不再被同步登记的"孤儿文件"堆积在磁盘
        if (deleteFailed) {
          append(
            `[cleanup] 【警告】文件已上传,但本地文件删除失败(已记录墓碑,不再显示为卡片)。` +
              `请手动清理: ${workFile.absolutePath} (原因: ${deleteFailed})`,
          );
          console.error(
            `[postprocess] move 模式下本地文件删除失败,请手动清理: ${workFile.absolutePath} (${deleteFailed})`,
          );
        }
      } else {
        const stillExists =
          !!workFile.absolutePath && fs.existsSync(workFile.absolutePath);
        deletedLocal = !stillExists;
        fileRepo.update(workFile.id, {
          status: 'uploaded',
          uploadedAt: nowIso(),
          absolutePath: stillExists ? workFile.absolutePath : '',
          size: stillExists ? fs.statSync(workFile.absolutePath).size : 0,
          error: null,
        });
      }
      jobRepo.update(jobId, {
        status: 'success',
        log,
        finishedAt: nowIso(),
      });
      append('[done] 后处理成功');
      return { ok: true, deleted: deletedLocal };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      append(`[fail] ${msg}`);

      // 本地文件仍完好时自动延迟重试(超时/网络/限流等瞬时错误),
      // 最多 POSTPROCESS_MAX_RETRY 次;全部失败后才标记永久 error。
      // 修复:旧逻辑失败一次即标记 error,卡片永久卡死、不自动重试、
      // 文件不断堆积直至磁盘爆满、Web UI 崩溃。
      const fileStillExists = !!file.absolutePath && fs.existsSync(file.absolutePath);
      const canRetry = attempt < POSTPROCESS_MAX_RETRY && fileStillExists;

      if (canRetry) {
        // 任务记录立即完结(该次尝试失败),文件记录回退为 ready 供重试/手动触发
        jobRepo.update(jobId, {
          status: 'failed',
          log,
          finishedAt: nowIso(),
        });
        fileRepo.update(file.id, {
          status: 'ready',
          error: msg,
        });
        const delaySec = POSTPROCESS_RETRY_BASE_DELAY_SEC * 2 ** attempt;
        append(`[retry] 将在 ${delaySec}s 后自动重试 (第 ${attempt + 1}/${POSTPROCESS_MAX_RETRY} 次)`);
        console.warn(
          `[postprocess] ${file.filename} 上传失败,将在 ${delaySec}s 后自动重试: ${msg}`,
        );
        setTimeout(() => {
          // 重试前复查:记录可能已被手动删除/上传完成(move 删除记录或 copy 标记 uploaded),
          // 此时不再入队,避免重复上传或对已删文件做无意义重试
          const latest = fileRepo.get(file.id);
          if (!latest) return;
          if (latest.status === 'uploaded' || latest.status === 'recording') return;
          this.enqueue(file.id, trigger, attempt + 1);
        }, delaySec * 1000);
      } else {
        fileRepo.update(file.id, { status: 'error', error: msg });
        jobRepo.update(jobId, {
          status: 'failed',
          log,
          finishedAt: nowIso(),
        });
      }
      throw error;
    } finally {
      // 清除上传进度跟踪
      this.clearProgress(file.id);
      // 清理临时脚本(兼容两种命名,确保失败路径也不残留)
      for (const name of [`post_${jobId}.sh`, `post_rclone_${jobId}.sh`]) {
        try {
          const scriptPath = path.join(PATHS.data, 'scripts', name);
          if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
        } catch {
          // ignore
        }
      }
    }
  }

  /** grammY 上传路径(替代原 tdl) */
  private async executeGrammyUpload(
    workFile: RecordingFile,
    settings: Settings,
    trigger: PostProcessTrigger,
    append: (s: string) => void,
  ) {
    append(`[grammy] 使用 grammY 上传 trigger=${trigger}`);
    append(`[grammy] mode=${settings.grammyMode}`);

    // 生成标签
    const streamer = workFile.streamerId
      ? streamerRepo.get(workFile.streamerId)
      : null;
    const tags = generateTags({
      streamerName: workFile.streamerName,
      platform: streamer?.platform || 'xhs',
    });
    append(`[grammy] 标签: ${tags}`);

    // 使用内置 grammY 上传(连接 Local Bot API Server)
    append(`[grammy] 使用内置 grammY + Local Bot API Server 上传`);
    const uploadResult = await grammyService.upload({
      settings,
      filePath: workFile.absolutePath,
      caption: tags,
      onLog: append,
      onProgress: (info) => {
        this.setProgress(workFile.id, {
          progress: Math.round(info.progress * 100),
          speed: info.speed,
          uploadedBytes: info.uploadedBytes,
          totalBytes: info.totalBytes || workFile.size || 0,
          phase: 'uploading',
        });
      },
    });
    append(`[grammy] 远程路径: ${uploadResult.remotePath}`);
    fileRepo.update(workFile.id, { remotePath: uploadResult.remotePath });

    // move 模式:删除本地文件
    if (
      settings.grammyMode === 'move' &&
      workFile.absolutePath &&
      fs.existsSync(workFile.absolutePath)
    ) {
      try {
        fs.unlinkSync(workFile.absolutePath);
        append('[cleanup] move 模式: 已删除本地文件');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        append(`[cleanup] 删除本地文件失败: ${msg}`);
      }
    }
  }

  /** rclone 上传路径(原有逻辑) */
  private async executeRcloneUpload(
    workFile: RecordingFile,
    settings: Settings,
    trigger: PostProcessTrigger,
    append: (s: string) => void,
    jobId: string,
  ) {
    // 写临时脚本执行(文件名与 jobId 绑定,失败时由 execute() 的 finally 精确清理)
    const scriptDir = path.join(PATHS.data, 'scripts');
    ensureDir(scriptDir);
    const scriptPath = path.join(scriptDir, `post_rclone_${jobId}.sh`);
    const scriptBody = settings.postProcessScript || '';
    fs.writeFileSync(scriptPath, scriptBody.replace(/\r\n/g, '\n'), {
      mode: 0o755,
    });
    try {
      fs.chmodSync(scriptPath, 0o755);
    } catch {
      // ignore on some fs
    }

    const remotePath = `${settings.rcloneRemote}:${settings.rcloneRemotePath}/${safeName(workFile.streamerName)}/${workFile.filename}`;
    append(`[rclone] 执行后处理脚本 trigger=${trigger}`);
    append(`[rclone] mode=${settings.rcloneMode} delete_local=${settings.rcloneDeleteLocalOnMove}`);
    append(`[rclone] remote=${remotePath}`);

    const errLines: string[] = [];
    const { done } = runCommand('sh', [scriptPath], {
      env: {
        // 新命名(CaptureHub)
        CAPTUREHUB_FILE_PATH: workFile.absolutePath,
        CAPTUREHUB_FILE_NAME: workFile.filename,
        CAPTUREHUB_STREAMER: safeName(workFile.streamerName),
        CAPTUREHUB_REMOTE: settings.rcloneRemote,
        CAPTUREHUB_REMOTE_ROOT: settings.rcloneRemotePath,
        CAPTUREHUB_TRIGGER: trigger,
        CAPTUREHUB_RCLONE: settings.rclonePath,
        CAPTUREHUB_RCLONE_MODE: settings.rcloneMode,
        CAPTUREHUB_DELETE_LOCAL: settings.rcloneDeleteLocalOnMove ? '1' : '0',
        // 旧命名(RED_*)保留,兼容已保存的旧脚本
        RED_FILE_PATH: workFile.absolutePath,
        RED_FILE_NAME: workFile.filename,
        RED_STREAMER: safeName(workFile.streamerName),
        RED_REMOTE: settings.rcloneRemote,
        RED_REMOTE_ROOT: settings.rcloneRemotePath,
        RED_TRIGGER: trigger,
        RED_RCLONE: settings.rclonePath,
        RED_RCLONE_MODE: settings.rcloneMode,
        RED_DELETE_LOCAL: settings.rcloneDeleteLocalOnMove ? '1' : '0',
        RCLONE_CONFIG: process.env.RCLONE_CONFIG || '/config/rclone/rclone.conf',
        HOME: process.env.HOME || '/home/node',
        PATH: process.env.PATH,
      },
      onStdout: (line) => {
        append(`[out] ${line}`);
        // 尝试解析 rclone 进度行(--stats-one-line 输出到 stdout)
        const p = parseRcloneProgressLine(line);
        if (p) {
          this.setProgress(workFile.id, {
            progress: p.progress,
            speed: p.speed,
            uploadedBytes: p.uploadedBytes,
            totalBytes: p.totalBytes || workFile.size || 0,
            phase: 'uploading',
          });
        }
      },
      onStderr: (line) => {
        append(`[err] ${line}`);
        // 尝试解析 rclone 进度行(--progress 输出到 stderr)
        const p = parseRcloneProgressLine(line);
        if (p) {
          this.setProgress(workFile.id, {
            progress: p.progress,
            speed: p.speed,
            uploadedBytes: p.uploadedBytes,
            totalBytes: p.totalBytes || workFile.size || 0,
            phase: 'uploading',
          });
        }
        if (line.includes('ERROR')) errLines.push(line);
      },
    });

    const result = await done;
    if (result.code !== 0) {
      let detailMsg = '';
      if (errLines.length > 0) {
        const line = errLines[0];
        const codeMatch = line.match(/Error "([^"]+)"/);
        const titleMatch = line.match(/"title"\s*:\s*"([^"]+)"/);
        if (codeMatch && titleMatch) {
          detailMsg = `${codeMatch[1]}: ${titleMatch[1]}`;
        } else if (titleMatch) {
          detailMsg = titleMatch[1];
        } else if (codeMatch) {
          detailMsg = codeMatch[1];
        } else {
          const rawMatch = line.match(/\] ERROR\s*:\s*(.+)/);
          detailMsg = rawMatch
            ? rawMatch[1].trim()
            : line.replace(/^\[err\]\s*/, '').trim();
          if (detailMsg.length > 200) detailMsg = detailMsg.slice(0, 200) + '...';
        }
      }
      throw new Error(detailMsg || `脚本退出码 ${result.code}`);
    }

    fileRepo.update(workFile.id, { remotePath });

    // move 模式兜底:rclone move 已自带删除;此处仅在脚本可能未删时强制清一次
    if (
      settings.rcloneMode === 'move' &&
      workFile.absolutePath &&
      fs.existsSync(workFile.absolutePath)
    ) {
      try {
        fs.unlinkSync(workFile.absolutePath);
        append('[cleanup] move 模式: 已删除本地文件');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        append(`[cleanup] 删除本地文件失败: ${msg}`);
      }
    }

    // 清理临时脚本
    try {
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    } catch { /* ignore */ }
  }

  private async transcodeToMp4(
    file: RecordingFile,
    ffmpegPath: string,
    append: (s: string) => void,
  ): Promise<RecordingFile> {
    const dir = path.dirname(file.absolutePath);
    const base = path.basename(file.filename, path.extname(file.filename));
    const outName = `${base}.mp4`;
    const outPath = path.join(dir, outName);
    const rel = path
      .relative(loadSettings().recordingsDir, outPath)
      .replace(/\\/g, '/');

    // 关键:先更新文件记录指向 .mp4 目标路径(保持 processing 状态),再执行转码。
    // 否则转码期间磁盘同步 syncFilesFromDisk 扫描到"尚无记录"的 .mp4 时,
    // 会新建一条 ready 重复记录;move 上传完成后该重复记录残留成"幽灵卡片",
    // 表现为"上传完成后文件记录不会自动删除"。
    fileRepo.update(file.id, {
      filename: outName,
      absolutePath: outPath,
      relativePath: rel,
      format: 'mp4',
      status: 'processing',
    });

    try {
      // 策略1: 全流 copy(最佳 — 完全保留原始分辨率/码率/帧率/编码)
      append(`[transcode] 尝试 -c copy(保留原始画质)`);
      const tryCopy = await this.runFfmpeg(
        ffmpegPath,
        [
          '-y',
          '-i',
          file.absolutePath,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outPath,
        ],
        append,
      );

      if (tryCopy && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
        append('[transcode] -c copy 成功,原始画质完整保留');
      } else {
        // 策略2: 视频copy + 音频转码(常用于音频编码不兼容 MP4 的情况)
        append('[transcode] -c copy 失败,尝试 -c:v copy -c:a aac');
        const tryVideoCopy = await this.runFfmpeg(
          ffmpegPath,
          [
            '-y',
            '-i',
            file.absolutePath,
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-movflags',
            '+faststart',
            outPath,
          ],
          append,
        );

        if (tryVideoCopy && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
          append('[transcode] -c:v copy 成功,视频原始画质保留');
        } else {
          // 策略3: 高质量重编码(仅在 copy 完全失败时使用)
          // 使用 CRF 18(视觉无损)+ medium 预设,保留原始分辨率和帧率
          append('[transcode] copy 均失败,使用高质量重编码 CRF=18');
          const re = await this.runFfmpeg(
            ffmpegPath,
            [
              '-y',
              '-i',
              file.absolutePath,
              '-c:v',
              'libx264',
              '-preset',
              'medium',
              '-crf',
              '18',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-b:a',
              '192k',
              '-movflags',
              '+faststart',
              outPath,
            ],
            append,
          );
          // 转码失败:清理半成品文件,防止 syncFilesFromDisk 把残骸登记成"幽灵"卡片
          const outOk = re && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024;
          if (!outOk) {
            try {
              if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            } catch { /* ignore */ }
            throw new Error('转码失败');
          }
        }
      }

      // 删除源文件(非 mp4)
      if (file.absolutePath !== outPath) {
        try {
          fs.unlinkSync(file.absolutePath);
        } catch {
          // ignore
        }
      }

      const size = fs.statSync(outPath).size;

      // 转码完成后保持 processing 状态(不能改回 ready):
      // 否则前端会误判为"就绪",进度轮询停止、上传进度/速度/进度条丢失,
      // 且可能被再次点击"上传"触发并发。等待后续上传完成后再更新最终状态。
      const updated = fileRepo.update(file.id, {
        size,
        status: 'processing',
      });
      return updated || file;
    } catch (e) {
      // 转码失败:回滚记录到源文件路径(状态由调用方置为 error),
      // 保证记录的 absolutePath 与实际存在的文件一致
      fileRepo.update(file.id, {
        filename: file.filename,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        size: file.size,
        format: file.format,
      });
      throw e;
    }
  }

  private async runFfmpeg(
    ffmpegPath: string,
    args: string[],
    append: (s: string) => void,
  ) {
    // 强制 -nostats:ffmpeg 默认每秒向 stderr 输出进度行,
    // 长视频转码(30+ 分钟)会生成数千行日志并频繁写库(每行一次 jobRepo.update),
    // 拖慢上传流程且刷爆任务日志;错误/警告仍正常输出
    const fullArgs = ['-nostats', ...args];
    append(`[ffmpeg] ${ffmpegPath} ${fullArgs.join(' ')}`);
    const { done } = runCommand(ffmpegPath, fullArgs, {
      onStdout: (l) => append(`[ffmpeg] ${l}`),
      onStderr: (l) => append(`[ffmpeg] ${l}`),
    });
    const r = await done;
    return r.code === 0;
  }
}

export const postProcessService = new PostProcessService();
