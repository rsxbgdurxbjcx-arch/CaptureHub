/**
 * 弹幕录制服务 — 会话注册表
 * 由 recorderService 在录制开播/切片/结束时调用:
 *   startFor() 开录 → rollTo() 切片跟随 → stop() 收尾
 * 弹幕连接独立于视频录制, 失败只重试不阻塞录制。
 */
import type { Platform } from '../types.js';
import { DanmakuSession, type DanmakuPlatform } from './session.js';

export interface DanmakuStartOptions {
  streamerId: string;
  platform: Platform;
  roomId: string;
  /** 当前视频段路径 (弹幕文件与其同名同目录) */
  videoPath: string;
}

class DanmakuService {
  private sessions = new Map<string, DanmakuSession>();

  /** 该平台是否支持弹幕录制 */
  supports(platform: Platform): boolean {
    return platform === 'douyu' || platform === 'huya' || platform === 'bilibili';
  }

  /** 开始某个主播的弹幕录制 (不支持/参数不满足时静默跳过) */
  startFor(opts: DanmakuStartOptions): void {
    if (!this.supports(opts.platform)) return;
    if (!opts.roomId) return;
    // 防御: 同一主播已有会话时先收尾, 避免泄漏
    this.stop(opts.streamerId);
    try {
      const session = new DanmakuSession({
        streamerId: opts.streamerId,
        platform: opts.platform as DanmakuPlatform,
        roomId: opts.roomId,
        videoPath: opts.videoPath,
      });
      this.sessions.set(opts.streamerId, session);
    } catch (e) {
      console.warn(
        `[danmaku] 启动失败 streamer=${opts.streamerId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** 录制切片: 弹幕文件切换到新视频段同名文件 */
  rollTo(streamerId: string, videoPath: string): void {
    this.sessions.get(streamerId)?.rollTo(videoPath);
  }

  /** 停止并收尾某个主播的弹幕录制 */
  stop(streamerId: string): void {
    const session = this.sessions.get(streamerId);
    if (!session) return;
    this.sessions.delete(streamerId);
    try {
      session.stop();
    } catch (e) {
      console.warn(
        `[danmaku] 停止失败 streamer=${streamerId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** 停止全部会话 (进程退出时兜底) */
  stopAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.stop(id);
    }
  }
}

export const danmakuService = new DanmakuService();
