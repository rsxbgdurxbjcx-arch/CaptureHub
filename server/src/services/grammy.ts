/**
 * grammY 上传服务:通过内置 Local Bot API Server 上传视频到 Telegram 群组
 *
 * 核心能力:
 * 1. 连接 CaptureHub 内置拉起的 Local Bot API Server(不走外部网络)
 * 2. 本地路径回环直传 Local Bot API Server,支持 2GB/4GB 大视频
 * 3. ffmpeg/ffprobe 提取 duration/width/height + 首帧封面 → 原生视频气泡
 * 4. 自动生成 Hashtag 标签作为 caption
 * 5. Chat ID 兼容普通群组(负数)与超级群组(-100 前缀长数字),全程 String 处理
 * 6. 队列限流 + 429 FloodWait 自动重试,防封号
 */
import { Bot, GrammyError, HttpError, InputFile } from 'grammy';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import type { Platform, Settings } from '../types.js';
import { runCommand, sleep, getDiskFreeBytes } from '../utils.js';
import { botServerManager } from './bot-server-manager.js';

/** 视频元数据 */
interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

/** 媒体探测结果(用于 Telegram 兼容性判断) */
interface MediaProbe {
  hasVideo: boolean;
  hasAudio: boolean;
  vCodec: string;
  aCodec: string;
  width: number;
  height: number;
  pixFmt: string;
}

/** 上传入参 */
export interface GrammyUploadOptions {
  settings: Settings;
  filePath: string;
  caption: string;
  onLog?: (line: string) => void;
  /** progress: 0-1, speed: bytes/sec, uploadedBytes, totalBytes */
  onProgress?: (info: {
    progress: number;
    speed: number;
    uploadedBytes: number;
    totalBytes: number;
  }) => void;
}

/** 上传结果 */
interface UploadResult {
  ok: boolean;
  remotePath: string;
}

/** 队列任务 */
interface QueueTask {
  opts: GrammyUploadOptions;
  resolve: (result: UploadResult) => void;
  reject: (error: Error) => void;
}

/**
 * 根据文件大小动态计算单次上传的超时上限(秒)
 *
 * 超时必须覆盖完整链路:grammY →(127.0.0.1 回环)→ Local Bot API Server 接收文件
 * + Local Bot API Server →(外网)→ Telegram DC 上传完成并返回 message_id。
 * 外网上传速度取决于 VPS 带宽,无法提前预知,因此:
 * - 按最低 0.2 MB/s(1.6 Mbps)的保守带宽估算耗时,覆盖绝大多数 VPS
 *   (0.5 MB/s 在 1.8GB 大文件上会把 1h 级上传判定为超时,导致
 *   上传失败 → 文件卡死堆积 → 磁盘爆满,故下调)
 * - 额外加 15 分钟缓冲,避免慢速窗口期误杀
 * - 下限 30 分钟(小文件也保留足够余量),上限 12 小时(避免失去超时保护意义)
 */
function calcTimeoutSeconds(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 1800;
  const MIN_BANDWIDTH = 0.2 * 1024 * 1024; // 0.2 MB/s 保守下限
  const estimatedSec = totalBytes / MIN_BANDWIDTH;
  const withBuffer = estimatedSec + 900; // +15 分钟缓冲
  const clamped = Math.min(12 * 3600, Math.max(1800, withBuffer));
  return Math.ceil(clamped);
}

/**
 * 查询 Local Bot API Server 的真实文件上传状态。
 *
 * tdlib telegram-bot-api 本地提供非官方端点 getFileUploadStatus,
 * grammY 官方 API 并未打包该方法(api.raw 中不存在),因此:
 * - 旧实现经由 bot.api.raw.getFileUploadStatus 调用必然得到 undefined,
 *   永远落回"本地回环已读字节"兜底,且本地段极快读完,进度条近乎无感知;
 * - 本例改用裸 fetch 直连 Local Server 查询,兼容两种路径:
 *   {apiRoot}/bot{token}/getFileUploadStatus 与 {apiRoot}/getFileUploadStatus。
 *
 * 响应数组每项包含 uploaded_size/expected_size(tdlib 实际字段);
 * 同时兼容旧命名 offset/size。端点不可用时返回 null,由调用方回退本地字节流估算。
 */
async function fetchLocalUploadStatus(
  apiRoot: string,
  botToken: string,
): Promise<Array<{ offset: number; size: number }> | null> {
  const paths = [
    `${apiRoot}/bot${botToken}/getFileUploadStatus`,
    `${apiRoot}/getFileUploadStatus`,
  ];
  for (const url of paths) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) continue;
      const items = data
        .map((it) => {
          const o = (it ?? {}) as Record<string, unknown>;
          const size = Number(o.expected_size ?? o.size ?? 0);
          const offset = Number(o.uploaded_size ?? o.offset ?? 0);
          return {
            offset: Number.isFinite(offset) ? offset : 0,
            size: Number.isFinite(size) ? size : 0,
          };
        })
        .filter((it) => it.size > 0);
      if (items.length > 0) return items;
    } catch {
      // 尝试下一个路径
    }
  }
  return null;
}

class GrammyService {
  /** 上传队列(支持并发,由 grammyMaxConcurrentUploads 控制) */
  private queue: QueueTask[] = [];
  private activeCount = 0;
  /** 缓存的 Bot 实例(避免重复创建) */
  private cachedBot: {
    token: string;
    apiRoot: string;
    timeoutSeconds: number;
    bot: Bot;
  } | null = null;
  /** 正在生成兼容转码文件的 basename 集合(防止并发任务复用半成品) */
  private compatBusy = new Set<string>();

  /**
   * 主入口:上传视频到 Telegram
   * 内部通过队列并发执行(并发数由配置 grammyMaxConcurrentUploads 控制),
   * 自动处理 FloodWait 重试。
   */
  upload(opts: GrammyUploadOptions): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ opts, resolve, reject });
      void this.pump();
    });
  }

  /** 并发上限(取队列头部任务的 settings,独立于 rclone) */
  private getMaxConcurrent(): number {
    const s = this.queue[0]?.opts.settings;
    const max = s?.grammyMaxConcurrentUploads || 1;
    return Math.max(1, max);
  }

  /** 队列调度(并发执行) */
  private pump() {
    while (this.activeCount < this.getMaxConcurrent() && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.activeCount++;
      this.executeUpload(task.opts)
        .then((result) => task.resolve(result))
        .catch((e) => task.reject(e instanceof Error ? e : new Error(String(e))))
        .finally(() => {
          this.activeCount--;
          void this.pump();
        });
    }
  }

  /** 执行单次上传(含重试) */
  private async executeUpload(opts: GrammyUploadOptions): Promise<UploadResult> {
    const { settings, filePath, caption, onLog } = opts;
    const log = (s: string) => onLog?.(s);

    const botToken = settings.grammyBotToken?.trim();
    const chatId = settings.grammyChatId?.trim();
    const apiId = settings.grammyApiId?.trim();
    const apiHash = settings.grammyApiHash?.trim();
    const localPort = settings.grammyLocalPort || 8081;
    const ffmpegPath = settings.ffmpegPath || 'ffmpeg';

    if (!botToken) throw new Error('请填写 grammY Bot Token');
    if (!chatId) throw new Error('请填写 Chat ID');
    if (!apiId || !apiHash) throw new Error('请填写 API ID 和 API HASH(用于启动 Local Server)');

    // 1. 确保 Local Bot API Server 已启动
    log(`[grammy] 检查 Local Bot API Server (端口 ${localPort})...`);
    const serverStatus = botServerManager.getStatus();
    if (serverStatus.status !== 'running') {
      log(`[grammy] Local Server 状态: ${serverStatus.status},正在启动...`);
      await botServerManager.start({
        apiId,
        apiHash,
        port: localPort,
        binaryPath: settings.telegramBotApiPath || 'telegram-bot-api',
        botToken,
      });
    } else {
      // 已运行但配置可能不同,重新确保配置一致
      await botServerManager.start({
        apiId,
        apiHash,
        port: localPort,
        binaryPath: settings.telegramBotApiPath || 'telegram-bot-api',
        botToken,
      });
    }

    const apiRoot = botServerManager.getApiRoot();
    log(`[grammy] Local Server 就绪: ${apiRoot}`);

    // 2. Telegram 兼容性保证: sendVideo 要求 MP4 + H.264 + AAC + yuv420p + 偶数分辨率。
    //    抖音等平台的源流可能是 H.265 / ByteVC1 等编码,直接上传会表现为
    //    「只有声音、画面马赛克」;此处探测编码,不符合时重编码为 H.264+AAC。
    const compat = await this.ensureTelegramCompatible(filePath, ffmpegPath, log);
    const uploadPath = compat.path;

    // 3. 计算上传超时上限并获取 Bot 实例
    const totalBytes = fs.existsSync(uploadPath) ? fs.statSync(uploadPath).size : 0;
    const timeoutSeconds = calcTimeoutSeconds(totalBytes);
    log(
      `[grammy] 文件大小: ${(totalBytes / 1024 / 1024).toFixed(1)} MB, ` +
      `上传超时上限: ${timeoutSeconds}s (动态计算, 覆盖本地接收 + Telegram 外网上传)`,
    );
    const bot = await this.getBot(botToken, apiRoot, timeoutSeconds, log);

    // 4. 标准化 Chat ID(全程 String,防止 -100 长数字精度丢失)
    const normalizedChatId = this.normalizeChatId(chatId);
    log(`[grammy] 原始 Chat ID: ${chatId}`);
    log(`[grammy] 标准化 Chat ID: ${normalizedChatId}`);

    // 5. 提取视频元数据
    log(`[grammy] 提取视频元数据...`);
    const meta = await this.getVideoMeta(uploadPath, ffmpegPath);
    if (meta) {
      log(`[grammy] 时长=${meta.duration}s 分辨率=${meta.width}x${meta.height}`);
    } else {
      log(`[grammy] 无法提取元数据,使用默认值`);
    }

    // 6. 生成封面缩略图
    log(`[grammy] 生成视频封面...`);
    const thumbnailPath = await this.generateThumbnail(uploadPath, ffmpegPath, log);
    if (thumbnailPath) {
      log(`[grammy] 封面已生成: ${thumbnailPath}`);
    } else {
      log(`[grammy] 封面生成失败,跳过`);
    }

    // 7. 检测文件是否为视频
    const isVideo = /\.(mp4|mkv|ts|webm|avi|mov|flv|m4v)$/i.test(uploadPath);
    log(`[grammy] 文件: ${uploadPath}`);
    log(`[grammy] 视频文件: ${isVideo ? '是' : '否'}`);
    log(`[grammy] Caption: ${caption}`);

    // 8. 真实上传进度追踪
    let localReadBytes = 0;
    const progressTracker = this.startProgressTracker(
      totalBytes,
      opts.onProgress,
      () => localReadBytes,
      apiRoot,
      botToken,
    );

    let uploadSucceeded = false;
    try {
      // 9. 构建上传参数
      const sendParams: Record<string, unknown> = {
        caption,
        parse_mode: 'HTML',
        supports_streaming: true,
      };

      // 视频元数据
      if (meta) {
        sendParams.duration = meta.duration;
        sendParams.width = meta.width;
        sendParams.height = meta.height;
      }

      // 10. 发送视频(带 FloodWait 重试;每次重试都会重建输入流)
      log(`[grammy] 开始上传 (本地路径回环直传 Local Bot API Server)...`);
      const result = await this.sendWithRetry(
        bot,
        normalizedChatId,
        uploadPath,
        thumbnailPath,
        sendParams,
        isVideo,
        (n) => { localReadBytes += n; },
        log,
      );

      uploadSucceeded = true;
      progressTracker.finish();
      const msgId = (result as { message_id?: number })?.message_id ?? 'unknown';
      log(`[grammy] 上传成功! 消息ID: ${msgId}`);

      return {
        ok: true,
        remotePath: `telegram:${chatId}/${msgId}`,
      };
    } catch (e) {
      progressTracker.finish();
      throw e;
    } finally {
      // 清理临时封面文件
      if (thumbnailPath) {
        try { fs.unlinkSync(thumbnailPath); } catch { /* ignore */ }
      }
      // 兼容性转码文件:上传成功才删除;
      // 失败时保留(隐藏文件),供自动重试复用,避免重复转码半小时
      // (由 scripts/cleanup-disk.sh 或清理孤儿文件机制兜底释放)
      if (compat.temp && compat.path) {
        if (uploadSucceeded) {
          try { fs.unlinkSync(compat.path); } catch { /* ignore */ }
        } else {
          console.warn(
            `[tg-compat] 上传失败,兼容转码文件保留供重试复用: ${compat.path}`,
          );
        }
      }
    }
  }

  /** 获取或创建缓存的 Bot 实例 */
  private async getBot(
    token: string,
    apiRoot: string,
    timeoutSeconds: number,
    log: (s: string) => void,
  ): Promise<Bot> {
    if (
      this.cachedBot &&
      this.cachedBot.token === token &&
      this.cachedBot.apiRoot === apiRoot &&
      this.cachedBot.timeoutSeconds === timeoutSeconds
    ) {
      log(`[grammy] 复用已缓存的 Bot 实例`);
      return this.cachedBot.bot;
    }

    // 清理旧实例
    if (this.cachedBot) {
      try { await this.cachedBot.bot.stop(); } catch { /* ignore */ }
      this.cachedBot = null;
    }

    log(`[grammy] 创建新的 Bot 实例 (apiRoot=${apiRoot}, timeoutSeconds=${timeoutSeconds})`);
    const bot = new Bot(token, {
      client: {
        apiRoot,
        timeoutSeconds,
      },
    });

    // 验证连接
    try {
      const me = await bot.api.getMe();
      log(`[grammy] Bot 认证成功: @${me.username} (${me.first_name})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Bot 认证失败: ${msg}。请检查 Bot Token 和 Local Server 是否正常。`);
    }

    this.cachedBot = { token, apiRoot, timeoutSeconds, bot };
    return bot;
  }

  /**
   * 标准化 Chat ID — 全程使用 String,绝不转 Number
   */
  private normalizeChatId(chatId: string): string {
    const trimmed = chatId.trim();
    if (!trimmed) return trimmed;

    // @username
    if (trimmed.startsWith('@')) return trimmed;
    // URL
    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    // 纯数字(含负号):原样返回,由 Bot API 处理
    return trimmed;
  }

  /**
   * 探测媒体编码信息(ffprobe)。
   * 失败(ffprobe 不可用/文件无法解析)时返回 null,由调用方按"原样上传"处理。
   */
  private async probeMedia(
    filePath: string,
    ffmpegPath: string,
  ): Promise<MediaProbe | null> {
    try {
      const ffprobePath = ffmpegPath.replace(/ffmpeg$/i, 'ffprobe') || 'ffprobe';
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        filePath,
      ];

      let output = '';
      const { done } = runCommand(ffprobePath, args, {
        onStdout: (line) => { output += line + '\n'; },
      });

      const result = await done;
      if (result.code !== 0 || !output.trim()) return null;

      const data = JSON.parse(output) as { streams?: Array<Record<string, unknown>> };
      const streams = data.streams ?? [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');

      return {
        hasVideo: !!v,
        hasAudio: !!a,
        vCodec: String(v?.codec_name ?? '').toLowerCase(),
        aCodec: String(a?.codec_name ?? '').toLowerCase(),
        width: Number(v?.width ?? 0),
        height: Number(v?.height ?? 0),
        pixFmt: String(v?.pix_fmt ?? '').toLowerCase(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Telegram 兼容性保证(核心修复)。
   *
   * Telegram Bot API 的 sendVideo 要求 MP4 + H.264 + AAC(实际播放宽容度较高,
   * yuvj420p 等 full-range YUV420P 变体亦可正常播放)。
   * 抖音等平台的直播流可能为 H.265 / ByteVC1 / 非 AAC 音频或奇偶分辨率异常,
   * 旧实现把"像素格式 ≠ yuv420p"(如 yuvj420p)一律重编码 —— 对 Stripchat
   * 录制(源即 yuvj420p)这意味着每次上传前都要把整段视频重编码 30 分钟,
   * 还额外写一份近似大小的临时文件;磁盘紧张/转码中断时任务永远失败,
   * 表现为"视频一直无法上传"。
   *
   * 处理策略:
   * - 探测后完全符合要求(yuv420p / yuvj420p 均视为兼容)→ 零开销直传原文件;
   * - 仅音频不符 → -c:v copy + 音频重编码 AAC(质量无损,不重编码视频);
   * - 视频编码/像素格式确实不符 → 重编码 H.264 (CRF 20, preset fast,
   *   yuv420p, 偶数分辨率),转码产物写入隐藏临时文件(.tg_compat_*.mp4,
   *   磁盘同步会跳过以 . 开头的文件);
   * - 转码产物在失败重试时复用(同段文件不再重复转码),上传成功后删除;
   * - 磁盘剩余空间不足时跳过转码直接上传原文件(避免"磁盘满→转码失败→卡死")。
   */
  private async ensureTelegramCompatible(
    filePath: string,
    ffmpegPath: string,
    log: (s: string) => void,
  ): Promise<{ path: string; temp: boolean }> {
    const probe = await this.probeMedia(filePath, ffmpegPath);
    if (!probe || !probe.hasVideo) {
      log(`[tg-compat] 无法探测媒体或视频轨缺失,按原文件上传`);
      return { path: filePath, temp: false };
    }

    // 像素格式:yuvj420p 即 full-range 的 yuv420p(Stripchat 等平台源流常见),
    // Telegram 客户端可直接解码;仅真正异常(如 yuv444p)才需要重编码
    const pixOk =
      !probe.pixFmt ||
      probe.pixFmt === 'yuv420p' ||
      probe.pixFmt === 'yuvj420p';
    const vOk =
      probe.vCodec === 'h264' &&
      pixOk &&
      probe.width % 2 === 0 &&
      probe.height % 2 === 0;
    const aOk = !probe.hasAudio || probe.aCodec === 'aac';

    if (vOk && aOk) {
      log(`[tg-compat] 检查通过 (${probe.vCodec}/${probe.pixFmt} ` +
        `${probe.width}x${probe.height}, ${probe.hasAudio ? probe.aCodec : '无音频'}),直传`);
      return { path: filePath, temp: false };
    }

    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));

    // 复用已生成的兼容转码产物(失败重试/进程重启后避免重复转码 30 分钟)
    if (!this.compatBusy.has(base)) {
      const cached = this.findCompatFile(dir, base);
      if (cached) {
        log(`[tg-compat] 复用已有兼容转码文件: ${path.basename(cached)}`);
        return { path: cached, temp: true };
      }
    }

    const outPath = path.join(
      dir,
      `.tg_compat_${base}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.mp4`,
    );

    // 只有视频真的需要重编码时才考虑磁盘空间:
    // 重编码产物 ≈ 源文件大小,需要同时存在,空间不足时改用直传(可能轻微不兼容但不会卡死)
    const needReencode = !vOk;
    if (needReencode) {
      const srcBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      const freeBytes = getDiskFreeBytes(dir);
      if (freeBytes < srcBytes * 2 + 512 * 1024 * 1024) {
        log(
          `[tg-compat] 磁盘空间不足(可用 ${Math.round(freeBytes / 1024 / 1024)} MB,` +
            `需要约 ${Math.round((srcBytes * 2 + 512 * 1024 * 1024) / 1024 / 1024)} MB),` +
            `跳过转码,按原文件上传(Telegram 若拒绝会在上传阶段明确报错)`,
        );
        return { path: filePath, temp: false };
      }
    }

    const args = ['-y', '-nostats', '-i', filePath];

    if (vOk) {
      // 视频本身兼容:仅音频不符 → 视频 copy,音频重编码(质量无损)
      args.push('-c:v', 'copy');
    } else {
      // preset fast:相比 medium 提速约 35%,视觉质量几乎无差异;
      // 对 Stripchat 27+ 分钟录制,重编码时间从 ~30 分钟降到 ~20 分钟
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p');
      if (!probe.width || !probe.height || probe.width % 2 !== 0 || probe.height % 2 !== 0) {
        args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      }
    }
    if (aOk) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
    args.push('-movflags', '+faststart', outPath);

    log(`[tg-compat] 需要转换 (video=${probe.vCodec}/${probe.pixFmt} ` +
      `${probe.width}x${probe.height}, audio=${probe.hasAudio ? probe.aCodec : '无音频'}),` +
      `${vOk ? '视频 copy + 音频重编码 AAC' : '视频重编码 H.264+AAC'}...`);
    this.compatBusy.add(base);
    try {
      const { done } = runCommand(ffmpegPath, args, {
        onStderr: (line) => log(`[ffmpeg:tgcompat] ${line}`),
      });
      const r = await done;
      if (r.code !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
        throw new Error(
          'Telegram 兼容转码失败:源视频编码无法解码(如 ByteVC1),请更换清晰度或稍后重试',
        );
      }
      log(`[tg-compat] 转码完成,将上传兼容版本`);
      return { path: outPath, temp: true };
    } finally {
      this.compatBusy.delete(base);
    }
  }

  /** 在录制目录中查找同一录制段的已有兼容转码产物(丢弃陈旧/过小的) */
  private findCompatFile(dir: string, base: string): string | null {
    try {
      const prefix = `.tg_compat_${base}_`;
      let best: { path: string; mtime: number } | null = null;
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(prefix) || !name.endsWith('.mp4')) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.size < 1024) continue;
          if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
        } catch { /* ignore */ }
      }
      return best?.path ?? null;
    } catch {
      return null;
    }
  }

  /** 使用 ffprobe 提取视频元数据 */
  private async getVideoMeta(
    filePath: string,
    ffmpegPath: string,
  ): Promise<VideoMeta | null> {
    try {
      const ffprobePath = ffmpegPath.replace(/ffmpeg$/i, 'ffprobe') || 'ffprobe';
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ];

      let output = '';
      const { done } = runCommand(ffprobePath, args, {
        onStdout: (line) => { output += line + '\n'; },
      });

      const result = await done;
      if (result.code !== 0 || !output.trim()) return null;

      const data = JSON.parse(output);
      const format = data.format || {};
      const videoStream = (data.streams || []).find(
        (s: { codec_type?: string }) => s.codec_type === 'video',
      );

      if (!videoStream) return null;

      const duration = Math.ceil(parseFloat(format.duration || videoStream.duration || '0'));
      const width = parseInt(videoStream.width || '0', 10);
      const height = parseInt(videoStream.height || '0', 10);

      if (duration > 0 && width > 0 && height > 0) {
        return { duration, width, height };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 使用 ffmpeg 截取首帧作为封面缩略图
   * Telegram 要求封面:≤320x320,JPEG 格式,≤200KB
   */
  private async generateThumbnail(
    filePath: string,
    ffmpegPath: string,
    log: (s: string) => void,
  ): Promise<string | null> {
    const tmpDir = os.tmpdir();
    const thumbPath = path.join(tmpDir, `capturehub_thumb_${Date.now()}.jpg`);

    try {
      const args = [
        '-y',
        '-ss', '1',
        '-i', filePath,
        '-vframes', '1',
        '-vf', 'scale=320:-1',
        '-q:v', '3',
        '-f', 'image2',
        thumbPath,
      ];

      const { done } = runCommand(ffmpegPath, args, {
        onStderr: (l) => log(`[ffmpeg:thumb] ${l}`),
      });

      const result = await done;
      if (result.code !== 0 || !fs.existsSync(thumbPath)) {
        // 第 1 秒可能不存在(短视频),尝试第 0 秒
        const args0 = [
          '-y',
          '-ss', '0',
          '-i', filePath,
          '-vframes', '1',
          '-vf', 'scale=320:-1',
          '-q:v', '3',
          '-f', 'image2',
          thumbPath,
        ];
        const r2 = runCommand(ffmpegPath, args0, {});
        const res2 = await r2.done;
        if (res2.code !== 0 || !fs.existsSync(thumbPath)) return null;
      }

      // 检查封面大小(Telegram 限制 ≤200KB)
      const stat = fs.statSync(thumbPath);
      if (stat.size > 200 * 1024) {
        // 过大则压缩
        const compressedPath = thumbPath.replace('.jpg', '_s.jpg');
        const compressArgs = [
          '-y',
          '-i', thumbPath,
          '-vf', 'scale=320:-1',
          '-q:v', '8',
          '-f', 'image2',
          compressedPath,
        ];
        const { done: d } = runCommand(ffmpegPath, compressArgs, {});
        await d;
        if (fs.existsSync(compressedPath)) {
          fs.unlinkSync(thumbPath);
          return compressedPath;
        }
      }

      return thumbPath;
    } catch (e) {
      log(`[ffmpeg:thumb] 封面生成异常: ${e instanceof Error ? e.message : String(e)}`);
      try { if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath); } catch { /* ignore */ }
      return null;
    }
  }

  /**
   * 发送视频,自动处理 429 FloodWait 重试
   * 最多重试 3 次
   */
  private async sendWithRetry(
    bot: Bot,
    chatId: string,
    filePath: string,
    thumbnailPath: string | null,
    sendParams: Record<string, unknown>,
    isVideo: boolean,
    onStreamBytes: (n: number) => void,
    log: (s: string) => void,
  ): Promise<unknown> {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const counter = new PassThrough();
      counter.on('data', (chunk: Buffer) => onStreamBytes(chunk.length));
      const rs = fs.createReadStream(filePath);
      rs.on('error', (err) => counter.destroy(err));
      rs.pipe(counter);
      const inputFile = new InputFile(counter, path.basename(filePath));
      const params: Record<string, unknown> = {
        ...sendParams,
        ...(thumbnailPath
          ? { thumbnail: new InputFile(thumbnailPath, 'thumbnail.jpg') }
          : {}),
      };
      try {
        if (isVideo) {
          return await bot.api.sendVideo(
            chatId as never,
            inputFile,
            params as never,
          );
        }
        // 非视频文件用 sendDocument
        return await bot.api.sendDocument(
          chatId as never,
          inputFile,
          { caption: params.caption, parse_mode: params.parse_mode } as never,
        );
      } catch (e) {
        const isFloodWait = this.isFloodWaitError(e);
        const retryAfter = this.extractRetryAfter(e);

        if (isFloodWait && attempt < maxRetries) {
          const waitSec = retryAfter > 0 ? retryAfter : Math.pow(2, attempt) * 5;
          log(`[grammy] FloodWait 429: 需等待 ${waitSec}s 后重试 (第 ${attempt + 1}/${maxRetries} 次)`);
          await sleep(waitSec * 1000);
          continue;
        }

        // 非限流错误或重试次数耗尽,抛出友好错误信息
        throw this.wrapError(e, log);
      }
    }
    throw new Error('上传失败:重试次数耗尽');
  }

  /** 判断是否为 FloodWait 429 错误 */
  private isFloodWaitError(e: unknown): boolean {
    if (e instanceof GrammyError) {
      return e.error_code === 429 || e.message.includes('Too Many Requests');
    }
    if (e instanceof Error) {
      return e.message.includes('429') || e.message.includes('Too Many Requests') ||
             e.message.includes('FLOOD_WAIT');
    }
    return false;
  }

  /** 从错误中提取 retry_after 秒数 */
  private extractRetryAfter(e: unknown): number {
    if (e instanceof GrammyError) {
      const params = (e as unknown as { parameters?: { retry_after?: number } }).parameters;
      if (params?.retry_after) return params.retry_after;
    }
    if (e instanceof Error) {
      const m = e.message.match(/(\d+)\s*seconds?/i);
      if (m) return parseInt(m[1], 10);
    }
    return 0;
  }

  /** 将原始错误包装为用户友好的错误信息 */
  private wrapError(e: unknown, log: (s: string) => void): Error {
    if (e instanceof GrammyError) {
      log(`[grammy] GrammyError: code=${e.error_code} ${e.message}`);
      switch (e.error_code) {
        case 400:
          if (e.message.includes('CHAT_ID_INVALID') || e.message.includes('chat not found')) {
            return new Error('Chat ID 无效。请确认 Bot 已加入目标群组,且 Chat ID 正确。');
          }
          if (e.message.includes('PHOTO_INVALID_DIMENSIONS') || e.message.includes('THUMBNAIL')) {
            return new Error('封面缩略图尺寸无效,请检查视频文件。');
          }
          if (e.message.includes('MESSAGE_CAPTION_TOO_LONG')) {
            return new Error('Caption 标签过长,请减少标签数量。');
          }
          return new Error(`请求参数错误: ${e.message}`);
        case 401:
          return new Error('Bot Token 无效,请检查 Token 是否正确。');
        case 403:
          if (e.message.includes('CHAT_WRITE_FORBIDDEN')) {
            return new Error('Bot 没有在群组中发送消息的权限。请将 Bot 加入群组并设为管理员。');
          }
          if (e.message.includes('CHAT_ADMIN_REQUIRED')) {
            return new Error('Bot 需要群组管理员权限。请将 Bot 设为群组管理员。');
          }
          return new Error(`权限不足: ${e.message}`);
        case 429:
          return new Error('Telegram 限流 (FloodWait):请求过于频繁,请稍后重试。');
        default:
          return new Error(`Telegram API 错误 (${e.error_code}): ${e.message}`);
      }
    }
    if (e instanceof HttpError) {
      const raw = e.error;
      const cause =
        raw instanceof Error
          ? raw.message
          : raw !== undefined && raw !== null
            ? String(raw)
            : '';
      log(`[grammy] HttpError: ${e.message}${cause ? ` (${cause})` : ''}`);
      return new Error(
        `网络错误: ${e.message}${cause ? `(原因: ${cause})` : ''}。请检查 Local Bot API Server 是否正常运行。`,
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    log(`[grammy] 上传失败: ${msg}`);
    // grammY 超时错误:Request to 'sendVideo' timed out after X seconds
    if (e instanceof Error && /timed out after/i.test(e.message)) {
      return new Error(
        `上传超时(${msg})。上传链路为 127.0.0.1 回环 + Telegram 外网上传,` +
        `已超过按文件大小计算的动态超时上限。请检查 VPS 上传带宽,` +
        `或减小切片文件大小后重试。`,
      );
    }
    return new Error(`grammY 上传失败: ${msg}`);
  }

  /**
   * 真实上传进度追踪器
   *
   * 进度数据来源(优先级从高到低):
   * 1. Local Bot API Server 真实上传状态(getFileUploadStatus 的
   *    uploaded_size/expected_size)——真实字节进度,频率 800ms;
   * 2. 本地回环流已读字节(端点不可用时的兜底)。
   *
   * 说明:完成前进度封顶 99%,只有 finish() 才上报 100%,
   * 避免"本地接收完成但 Telegram 外网仍在发送"时进度条提前满格停滞。
   * 上传全程每 800ms 持续心跳上报,确保前端进度条实时流动、不僵死。
   */
  private startProgressTracker(
    totalBytes: number,
    onProgress?: (info: {
      progress: number;
      speed: number;
      uploadedBytes: number;
      totalBytes: number;
    }) => void,
    getLocalBytes?: () => number,
    apiRoot?: string,
    botToken?: string,
  ): { finish: () => void } {
    if (!onProgress || totalBytes <= 0) {
      return { finish: () => {} };
    }

    let finished = false;
    let lastOffset = 0;
    let lastTs = Date.now();

    const report = (offset: number, size: number, progress?: number) => {
      const nowTs = Date.now();
      const dt = (nowTs - lastTs) / 1000;
      const delta = Math.max(0, offset - lastOffset);
      const speed = dt > 0 ? delta / dt : 0;
      lastOffset = offset;
      lastTs = nowTs;
      // 完成前封顶 99%(finish() 统一上报 100%)
      const p =
        progress !== undefined
          ? Math.min(progress, 0.99)
          : Math.min(0.99, size > 0 ? offset / size : 0);
      onProgress({
        progress: p,
        speed,
        uploadedBytes: offset,
        totalBytes: size,
      });
    };

    // 初始上报
    onProgress({ progress: 0, speed: 0, uploadedBytes: 0, totalBytes });

    const timer = setInterval(() => {
      if (finished) return;
      void (async () => {
        try {
          // 通道1: Local Bot API Server 真实上传状态(uploaded_size/expected_size)
          if (apiRoot && botToken) {
            const items = await fetchLocalUploadStatus(apiRoot, botToken);
            if (items && items.length > 0) {
              const item =
                (items.find((x) => x.size === totalBytes) as
                  | { offset: number; size: number }
                  | undefined) ||
                items.reduce((a, b) => (b.size > a.size ? b : a), items[0]);
              if (item && item.size > 0) {
                const received = Math.min(item.offset, item.size);
                report(received, item.size, received / item.size);
                return;
              }
            }
          }
          // 通道2(兜底): 本地回环流已读字节
          const local = getLocalBytes?.() ?? 0;
          if (local > 0) {
            report(Math.min(local, totalBytes), totalBytes);
          }
        } catch {
          // ignore:轮询失败不影响上传主流程
        }
      })();
    }, 800);

    return {
      finish: () => {
        finished = true;
        clearInterval(timer);
        onProgress({
          progress: 1,
          speed: 0,
          uploadedBytes: totalBytes,
          totalBytes,
        });
      },
    };
  }
}

export const grammyService = new GrammyService();

/**
 * 根据主播信息和平台生成标签
 * 统一命名规则: #主播名 #平台名,每个标签之间严格用一个空格隔开
 */
export function generateTags(opts: {
  streamerName: string;
  platform: Platform;
}): string {
  const { streamerName, platform } = opts;

  // 主播名标签:保留主播卡片内显示的名称(含中文),仅清理空格/换行等分隔符与 #/@ 前缀字符
  const nameTag = (streamerName || '')
    .replace(/[\s#@]+/g, '')
    .trim();
  const tags: string[] = [`#${nameTag || 'unknown'}`];

  // 平台名标签(与 README「标签自动生成」约定一致)
  let platformTag = '';
  switch (platform) {
    case 'douyin':
      platformTag = '#抖音';
      break;
    case 'bilibili':
      platformTag = '#哔哩哔哩';
      break;
    case 'xhs':
      platformTag = '#小红书';
      break;
    case 'kuaishou':
      platformTag = '#快手';
      break;
    case 'soop':
      platformTag = '#soop';
      break;
    case 'pandalive':
      platformTag = '#pandalive';
      break;
    case 'stripchat':
      platformTag = '#stripchat';
      break;
    default:
      platformTag = '';
  }
  if (platformTag) tags.push(platformTag);

  return tags.join(' ');
}
