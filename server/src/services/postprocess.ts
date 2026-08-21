import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PATHS, loadSettings } from '../config.js';
import { fileRepo, jobRepo, streamerRepo } from '../db/index.js';
import type { PostProcessTrigger, RecordingFile, Settings } from '../types.js';
import {
  ensureDir,
  newId,
  nowIso,
  runCommand,
  safeName,
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

export class PostProcessService {
  private queue: string[] = [];
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

  enqueue(fileId: string, trigger: PostProcessTrigger) {
    this.queue.push(JSON.stringify({ fileId, trigger }));
    void this.pump();
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
      const raw = this.queue.shift()!;
      const { fileId, trigger } = JSON.parse(raw) as {
        fileId: string;
        trigger: PostProcessTrigger;
      };
      this.activeCount++;
      void this.execute(fileId, trigger)
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

  private async execute(fileId: string, trigger: PostProcessTrigger) {
    if (!this.shouldRun(trigger)) {
      return { skipped: true };
    }

    const file = fileRepo.get(fileId);
    if (!file) throw new Error(`文件不存在: ${fileId}`);
    if (!fs.existsSync(file.absolutePath)) {
      throw new Error(`本地文件丢失: ${file.absolutePath}`);
    }

    const settings = loadSettings();
    const uploadTool = settings.uploadTool || 'rclone';
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
      jobRepo.update(jobId, { log });
    };

    try {
      let workFile = file;

      // 自动转码为 mp4
      if (settings.autoTranscode && !file.filename.toLowerCase().endsWith('.mp4')) {
        append(`[transcode] 开始转码 -> mp4`);
        workFile = await this.transcodeToMp4(file, settings.ffmpegPath, append);
      } else if (
        settings.autoTranscode &&
        file.filename.toLowerCase().endsWith('.ts')
      ) {
        append(`[transcode] ts 封装为 mp4`);
        workFile = await this.transcodeToMp4(file, settings.ffmpegPath, append);
      } else {
        append(`[transcode] 跳过(已是 mp4 或未开启自动转码)`);
      }

      // 根据上传工具选择上传路径
      this.setProgress(workFile.id, { phase: 'uploading', progress: 0 });
      if (uploadTool === 'grammy') {
        await this.executeGrammyUpload(workFile, settings, trigger, append);
      } else {
        await this.executeRcloneUpload(workFile, settings, trigger, append);
      }

      this.setProgress(workFile.id, { phase: 'finalizing', progress: 100, speed: 0 });

      // move 模式:上传完成 → 删除本地文件 + 无条件删除文件记录(卡片随文件一起消失)
      const isMoveMode =
        (uploadTool === 'grammy' && settings.grammyMode === 'move') ||
        (uploadTool === 'rclone' && settings.rcloneMode === 'move');

      let deletedLocal = false;
      if (isMoveMode) {
        // 尽力删除本地物理文件(rclone move / grammy move 可能已删,忽略不存在的情况)
        if (workFile.absolutePath && fs.existsSync(workFile.absolutePath)) {
          try {
            fs.unlinkSync(workFile.absolutePath);
            append(`[cleanup] ${uploadTool}·move 已删除本地文件`);
            deletedLocal = true;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            append(`[cleanup] 删除本地文件失败: ${msg}`);
          }
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
      fileRepo.update(file.id, { status: 'error', error: msg });
      jobRepo.update(jobId, {
        status: 'failed',
        log,
        finishedAt: nowIso(),
      });
      throw error;
    } finally {
      // 清除上传进度跟踪
      this.clearProgress(file.id);
      // 清理临时脚本
      try {
        const scriptPath = path.join(
          PATHS.data,
          'scripts',
          `post_${jobId}.sh`,
        );
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
      } catch {
        // ignore
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
  ) {
    // 写临时脚本执行
    const scriptDir = path.join(PATHS.data, 'scripts');
    ensureDir(scriptDir);
    const scriptPath = path.join(scriptDir, `post_rclone_${Date.now()}.sh`);
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
        if (!re || !fs.existsSync(outPath)) {
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
    const rel = path
      .relative(loadSettings().recordingsDir, outPath)
      .replace(/\\/g, '/');

    // 转码完成后保持 processing 状态(不能改回 ready):
    // 否则前端会误判为"就绪",进度轮询停止、上传进度/速度/进度条丢失,
    // 且可能被再次点击"上传"触发并发。等待后续上传完成后再更新最终状态。
    const updated = fileRepo.update(file.id, {
      filename: outName,
      absolutePath: outPath,
      relativePath: rel,
      size,
      format: 'mp4',
      status: 'processing',
    });
    return updated || file;
  }

  private async runFfmpeg(
    ffmpegPath: string,
    args: string[],
    append: (s: string) => void,
  ) {
    append(`[ffmpeg] ${ffmpegPath} ${args.join(' ')}`);
    const { done } = runCommand(ffmpegPath, args, {
      onStdout: (l) => append(`[ffmpeg] ${l}`),
      onStderr: (l) => append(`[ffmpeg] ${l}`),
    });
    const r = await done;
    return r.code === 0;
  }
}

export const postProcessService = new PostProcessService();
