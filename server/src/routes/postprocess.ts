import { Router } from 'express';
import { z } from 'zod';
import { loadSettings, saveSettings } from '../config.js';
import { jobRepo, getDb } from '../db/index.js';
import { postProcessService } from '../services/postprocess.js';
import { botServerManager } from '../services/bot-server-manager.js';
import type { ApiResponse, PostProcessJob, Settings } from '../types.js';

export const postprocessRouter = Router();

postprocessRouter.get('/jobs', (req, res) => {
  const limit = Number(req.query.limit || 50);
  const data = jobRepo.list(Number.isFinite(limit) ? limit : 50);
  res.json({ ok: true, data } satisfies ApiResponse<PostProcessJob[]>);
});

postprocessRouter.get('/jobs/:id', (req, res) => {
  const job = jobRepo.get(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: '任务不存在' } satisfies ApiResponse);
    return;
  }
  res.json({ ok: true, data: job } satisfies ApiResponse<PostProcessJob>);
});

const scriptSchema = z.object({
  uploadTool: z.enum(['grammy', 'rclone']).optional(),
  postProcessScript: z.string().optional(),
  postProcessOnStreamEnd: z.boolean().optional(),
  postProcessOnManualStop: z.boolean().optional(),
  postProcessOnSegment: z.boolean().optional(),
  rcloneRemote: z.string().optional(),
  rcloneRemotePath: z.string().optional(),
  rcloneMode: z.enum(['move', 'copy']).optional(),
  rcloneDeleteLocalOnMove: z.boolean().optional(),
  maxConcurrentUploads: z.number().min(1).max(20).optional(),
  // grammY 配置(替代 tdl)
  grammyBotToken: z.string().optional(),
  // Chat ID 必须用 String 处理,防止 -100 前缀长数字精度丢失
  grammyChatId: z.string().optional(),
  grammyApiId: z.string().optional(),
  grammyApiHash: z.string().optional(),
  grammyLocalPort: z.number().int().min(1).max(65535).optional(),
  grammyMode: z.enum(['move', 'copy']).optional(),
  grammyMaxConcurrentUploads: z.number().int().min(1).max(20).optional(),
  telegramBotApiPath: z.string().optional(),
});

postprocessRouter.get('/config', (_req, res) => {
  const s = loadSettings();
  res.json({
    ok: true,
    data: {
      uploadTool: s.uploadTool,
      postProcessScript: s.postProcessScript,
      postProcessOnStreamEnd: s.postProcessOnStreamEnd,
      postProcessOnManualStop: s.postProcessOnManualStop,
      postProcessOnSegment: s.postProcessOnSegment,
      rcloneRemote: s.rcloneRemote,
      rcloneRemotePath: s.rcloneRemotePath,
      rcloneMode: s.rcloneMode,
      rcloneDeleteLocalOnMove: s.rcloneDeleteLocalOnMove,
      maxConcurrentUploads: s.maxConcurrentUploads,
      grammyBotToken: s.grammyBotToken,
      grammyChatId: s.grammyChatId,
      grammyApiId: s.grammyApiId,
      grammyApiHash: s.grammyApiHash,
      grammyLocalPort: s.grammyLocalPort,
      grammyMode: s.grammyMode,
      grammyMaxConcurrentUploads: s.grammyMaxConcurrentUploads,
      telegramBotApiPath: s.telegramBotApiPath,
    },
  } satisfies ApiResponse);
});

postprocessRouter.put('/config', (req, res) => {
  try {
    const body = scriptSchema.parse(req.body);
    const cur = loadSettings();
    const next: Settings = {
      ...cur,
      ...body,
    };
    saveSettings(next);
    res.json({
      ok: true,
      data: {
        uploadTool: next.uploadTool,
        postProcessScript: next.postProcessScript,
        postProcessOnStreamEnd: next.postProcessOnStreamEnd,
        postProcessOnManualStop: next.postProcessOnManualStop,
        postProcessOnSegment: next.postProcessOnSegment,
        rcloneRemote: next.rcloneRemote,
        rcloneRemotePath: next.rcloneRemotePath,
        rcloneMode: next.rcloneMode,
        rcloneDeleteLocalOnMove: next.rcloneDeleteLocalOnMove,
        maxConcurrentUploads: next.maxConcurrentUploads,
        grammyBotToken: next.grammyBotToken,
        grammyChatId: next.grammyChatId,
        grammyApiId: next.grammyApiId,
        grammyApiHash: next.grammyApiHash,
        grammyLocalPort: next.grammyLocalPort,
        grammyMode: next.grammyMode,
        grammyMaxConcurrentUploads: next.grammyMaxConcurrentUploads,
        telegramBotApiPath: next.telegramBotApiPath,
      },
      message: '后处理配置已保存',
    } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

// -- Local Bot API Server 状态查询 --
postprocessRouter.get('/bot-server/status', (_req, res) => {
  const status = botServerManager.getStatus();
  res.json({ ok: true, data: status } satisfies ApiResponse);
});

// -- Local Bot API Server 启动 --
postprocessRouter.post('/bot-server/start', async (_req, res) => {
  try {
    const s = loadSettings();
    if (!s.grammyApiId?.trim() || !s.grammyApiHash?.trim()) {
      res.status(400).json({ ok: false, error: '请先填写 API ID 和 API HASH' } satisfies ApiResponse);
      return;
    }
    await botServerManager.start({
      apiId: s.grammyApiId,
      apiHash: s.grammyApiHash,
      port: s.grammyLocalPort || 8081,
      binaryPath: s.telegramBotApiPath || 'telegram-bot-api',
      botToken: s.grammyBotToken,
    });
    const status = botServerManager.getStatus();
    res.json({ ok: true, data: status, message: 'Local Bot API Server 已启动' } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

// -- Local Bot API Server 停止 --
postprocessRouter.post('/bot-server/stop', async (_req, res) => {
  try {
    await botServerManager.stop();
    const status = botServerManager.getStatus();
    res.json({ ok: true, data: status, message: 'Local Bot API Server 已停止' } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

postprocessRouter.post('/run/:fileId', async (req, res) => {
  try {
    await postProcessService.runNow(req.params.fileId, 'manual');
    res.json({ ok: true, message: '已执行后处理' } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

postprocessRouter.delete('/jobs', (req, res) => {
  // Delete all postprocess jobs from database
  getDb().exec('DELETE FROM postprocess_jobs');
  res.json({ ok: true, message: '已清除所有日志' });
});
