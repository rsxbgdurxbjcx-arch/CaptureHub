import { Router } from 'express';
import { loadSettings } from '../config.js';
import { fileRepo, streamerRepo } from '../db/index.js';
import { monitorService } from '../services/monitor.js';
import { recorderService } from '../services/recorder.js';
import type { ApiResponse, SystemStatus } from '../types.js';
import { whichSync } from '../utils.js';

export const systemRouter = Router();

systemRouter.get('/status', (_req, res) => {
  const settings = loadSettings();
  const streamers = streamerRepo.list();
  const data: SystemStatus = {
    uptimeSec: monitorService.getUptimeSec(),
    recordingCount: recorderService.getActiveCount(),
    streamerCount: streamers.length,
    onlineCount: streamers.filter(
      (s) => s.status === 'online' || s.status === 'recording',
    ).length,
    diskRecordingsBytes: fileRepo.sumSize(),
    tools: {
      ffmpeg: whichSync(settings.ffmpegPath),
      rclone: whichSync(settings.rclonePath),
      telegramBotApi: whichSync(settings.telegramBotApiPath),
    },
    version: 'v2.4.1',
  };
  res.json({ ok: true, data } satisfies ApiResponse<SystemStatus>);
});

systemRouter.get('/recordings', (_req, res) => {
  res.json({
    ok: true,
    data: recorderService.listActive(),
  } satisfies ApiResponse);
});

systemRouter.post('/monitor/restart', (_req, res) => {
  monitorService.restart();
  res.json({ ok: true, message: '监控循环已重启' } satisfies ApiResponse);
});

// 在线修复：清理所有残留的录制状态并触发后处理上传
systemRouter.post('/recover', (_req, res) => {
  const cleaned = recorderService.recoverOrphanedRecordings('manual_stop');
  res.json({
    ok: true,
    data: { cleaned },
    message: cleaned > 0
      ? `已恢复 ${cleaned} 个残留录制状态，已触发后处理上传`
      : '无残留录制状态需要恢复',
  } satisfies ApiResponse);
});
