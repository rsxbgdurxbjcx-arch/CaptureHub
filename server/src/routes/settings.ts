import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../config.js';
import { monitorService } from '../services/monitor.js';
import {
  getMouflonSyncState,
  recordManualKeysChange,
  syncMouflonKeysNow,
} from '../stripchat/mouflon.js';
import type { ApiResponse, Settings } from '../types.js';
import { parseDurationToSeconds, secondsToHms } from '../utils.js';

export const settingsRouter = Router();

const schema = z.object({
  pollIntervalSec: z.number().int().min(5).max(3600).optional(),
  segmentDuration: z.string().optional(),
  segmentFileSize: z
    .union([z.string(), z.number()])
    .transform(String)
    .refine(
      (v) => v.trim() === '' || /^\d+(\.\d{1,2})?$/.test(v.trim()),
      '切片文件大小需为非负数字,最多精确到小数点后两位(如 1950)',
    )
    .optional(),
  downloader: z.enum(['ffmpeg']).optional(),
  autoTranscode: z.boolean().optional(),
  cookie: z.string().optional(),
  cookieXhs: z.string().optional(),
  cookieDouyin: z.string().optional(),
  cookieBilibili: z.string().optional(),
  cookieKuaishou: z.string().optional(),
  cookieSoop: z.string().optional(),
  cookiePandalive: z.string().optional(),
  cookieStripchat: z.string().optional(),
  soopUsername: z.string().optional(),
  soopPassword: z.string().optional(),
  stripchatMouflonKeys: z.string().optional(),
  stripchatMouflonSyncUrl: z.string().optional(),
  stripchatMouflonSyncToken: z.string().optional(),
  recordQuality: z.enum(['OD', 'UHD', 'HD', 'SD', 'LD']).optional(),
  uploadTool: z.enum(['grammy', 'rclone']).optional(),
  rcloneRemote: z.string().optional(),
  rcloneRemotePath: z.string().optional(),
  rcloneMode: z.enum(['move', 'copy']).optional(),
  rcloneDeleteLocalOnMove: z.boolean().optional(),
  postProcessScript: z.string().optional(),
  postProcessOnStreamEnd: z.boolean().optional(),
  postProcessOnManualStop: z.boolean().optional(),
  postProcessOnSegment: z.boolean().optional(),
  // grammY 配置(替代 tdl)
  grammyBotToken: z.string().optional(),
  grammyChatId: z.string().optional(),
  grammyApiId: z.string().optional(),
  grammyApiHash: z.string().optional(),
  grammyLocalPort: z.number().int().min(1).max(65535).optional(),
  grammyMode: z.enum(['move', 'copy']).optional(),
  grammyMaxConcurrentUploads: z.number().int().min(1).max(20).optional(),
  telegramBotApiPath: z.string().optional(),
  ffmpegPath: z.string().optional(),
  rclonePath: z.string().optional(),
  maxConcurrentRecordings: z.number().int().min(-1).max(1000).optional(),
  maxConcurrentUploads: z.number().int().min(1).max(20).optional(),
});

settingsRouter.get('/', (_req, res) => {
  const data = loadSettings();
  res.json({ ok: true, data } satisfies ApiResponse<Settings>);
});

settingsRouter.put('/', (req, res) => {
  try {
    const body = schema.parse(req.body);
    const cur = loadSettings();

    if (body.segmentDuration !== undefined) {
      if (body.segmentDuration.trim() === '') {
        // 空字符串表示不切片
        body.segmentDuration = '';
      } else {
        const sec = parseDurationToSeconds(body.segmentDuration);
        // 规范化为 HH:MM:SS
        body.segmentDuration = secondsToHms(sec);
      }
    }

    const next: Settings = { ...cur, ...body };
    saveSettings(next);

    // Stripchat Mouflon 手动密钥发生变更 → 记录手动更新时间
    // (对应 StripchatRecorder MouflonKeysStore.manual_updated_at)
    if (
      body.stripchatMouflonKeys !== undefined &&
      body.stripchatMouflonKeys !== cur.stripchatMouflonKeys
    ) {
      recordManualKeysChange();
    }

    // 轮询间隔变更时重启监控
    if (
      body.pollIntervalSec !== undefined &&
      body.pollIntervalSec !== cur.pollIntervalSec
    ) {
      monitorService.restart();
    }

    res.json({
      ok: true,
      data: next,
      message: '设置已保存并生效',
    } satisfies ApiResponse<Settings>);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

// -- Stripchat Mouflon 密钥同步状态(参考 StripchatRecorder list_mouflon_keys) --
settingsRouter.get('/stripchat/mouflon/status', (_req, res) => {
  res.json({ ok: true, data: getMouflonSyncState() } satisfies ApiResponse);
});

// -- 手动触发一次 Mouflon 密钥同步(参考 StripchatRecorder sync_mouflon_keys) --
settingsRouter.post('/stripchat/mouflon/sync', async (_req, res) => {
  try {
    const result = await syncMouflonKeysNow();
    res.json({
      ok: true,
      data: result,
      message: result.updated
        ? '已从 Worker 同步到新的 Mouflon 密钥'
        : 'Mouflon 密钥已是最新,无需更新',
    } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

settingsRouter.post('/reset', (_req, res) => {
  saveSettings({ ...DEFAULT_SETTINGS });
  monitorService.restart();
  res.json({
    ok: true,
    data: loadSettings(),
    message: '已恢复默认设置',
  } satisfies ApiResponse<Settings>);
});
