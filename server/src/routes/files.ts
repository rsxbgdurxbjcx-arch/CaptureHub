import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { loadSettings } from '../config.js';
import { fileRepo, syncFilesFromDisk } from '../db/index.js';
import { postProcessService } from '../services/postprocess.js';
import type { ApiResponse, RecordingFile } from '../types.js';

export const filesRouter = Router();

filesRouter.get('/', (_req, res) => {
  const settings = loadSettings();
  syncFilesFromDisk(settings.recordingsDir);
  const data = fileRepo.list();
  res.json({ ok: true, data } satisfies ApiResponse<RecordingFile[]>);
});

/** 获取所有正在处理中文件的上传进度 */
filesRouter.get('/progress', (_req, res) => {
  const progress = postProcessService.getAllProgress();
  res.json({ ok: true, data: progress } satisfies ApiResponse);
});

/** 上传进度实时推送(SSE,供前端 EventSource 订阅) */
filesRouter.get('/progress/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (p: unknown) => {
    res.write(`data: ${JSON.stringify(p)}\n\n`);
  };

  // 新连接建立后,先推送当前所有进度快照
  for (const p of postProcessService.getProgressSnapshot()) {
    write(p);
  }

  const unsubscribe = postProcessService.subscribe(write);

  // 心跳保活,防止代理/浏览器断开空闲连接
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

/**
 * 实时获取录制中文件的真实大小(字节)
 * 返回 { fileId: size },供文件菜单"录制中"卡片实时刷新文件大小
 */
filesRouter.get('/sizes', (_req, res) => {
  const result: Record<string, number> = {};
  for (const f of fileRepo.list()) {
    if (f.status !== 'recording') continue;
    try {
      if (f.absolutePath && fs.existsSync(f.absolutePath)) {
        result[f.id] = fs.statSync(f.absolutePath).size;
      }
    } catch {
      // ignore
    }
  }
  res.json({ ok: true, data: result } satisfies ApiResponse);
});

/** 录制中文件实时大小推送(SSE,供前端 EventSource 订阅) */
filesRouter.get('/sizes/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const readSizes = (): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const f of fileRepo.list()) {
      if (f.status !== 'recording') continue;
      try {
        if (f.absolutePath && fs.existsSync(f.absolutePath)) {
          result[f.id] = fs.statSync(f.absolutePath).size;
        }
      } catch {
        // ignore
      }
    }
    return result;
  };

  const push = () => {
    res.write(`data: ${JSON.stringify(readSizes())}\n\n`);
  };

  // 连接建立后立即推送一次
  push();

  // 录制文件持续写入磁盘,无事件源,采用短周期后端读取+推送(真实数据)
  const timer = setInterval(push, 500);

  // 心跳保活
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    res.end();
  });
});

filesRouter.get('/:id', (req, res) => {
  const f = fileRepo.get(req.params.id);
  if (!f) {
    res.status(404).json({ ok: false, error: '文件不存在' } satisfies ApiResponse);
    return;
  }
  res.json({ ok: true, data: f } satisfies ApiResponse<RecordingFile>);
});

filesRouter.delete('/:id', (req, res) => {
  const f = fileRepo.get(req.params.id);
  if (!f) {
    res.status(404).json({ ok: false, error: '文件不存在' } satisfies ApiResponse);
    return;
  }
  // 兼容 move 后 absolutePath 已清空的情况
  if (f.absolutePath) {
    try {
      if (fs.existsSync(f.absolutePath)) {
        fs.unlinkSync(f.absolutePath);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res
        .status(500)
        .json({ ok: false, error: `删除物理文件失败: ${msg}` } satisfies ApiResponse);
      return;
    }
  }
  fileRepo.remove(f.id);
  res.json({ ok: true, message: '已删除' } satisfies ApiResponse);
});

filesRouter.post('/:id/upload', async (req, res) => {
  try {
    await postProcessService.runNow(req.params.id, 'manual');
    const f = fileRepo.get(req.params.id);
    // move 模式:上传完成后记录已被删除,data 返回 null,前端立即移除卡片
    res.json({
      ok: true,
      data: f ?? null,
      message: f ? '上传任务完成' : '上传完成,文件已删除(move 模式)',
    } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

filesRouter.post('/sync', (_req, res) => {
  const settings = loadSettings();
  syncFilesFromDisk(settings.recordingsDir);
  res.json({
    ok: true,
    data: fileRepo.list(),
    message: '已同步磁盘文件',
  } satisfies ApiResponse);
});

/** 批量删除文件 */
filesRouter.post('/batch/delete', (req, res) => {
  const ids = (req.body?.ids as string[]) || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ ok: false, error: '请提供要删除的文件ID列表' } satisfies ApiResponse);
    return;
  }
  let deleted = 0;
  for (const id of ids) {
    const f = fileRepo.get(id);
    if (!f) continue;
    if (f.absolutePath) {
      try {
        if (fs.existsSync(f.absolutePath)) {
          fs.unlinkSync(f.absolutePath);
        }
      } catch { /* ignore */ }
    }
    fileRepo.remove(id);
    deleted++;
  }
  res.json({
    ok: true,
    data: fileRepo.list(),
    message: `已删除 ${deleted} 个文件`,
  } satisfies ApiResponse);
});

/** 删除所有已上传的上传记录,保留录制中的卡片 */
filesRouter.delete('/uploaded/batch', (_req, res) => {
  const all = fileRepo.list();
  let deleted = 0;
  for (const f of all) {
    // 保留录制中的卡片
    if (f.status === 'recording') continue;
    // 删除已上传的记录(包括 uploaded 状态)
    if (f.status === 'uploaded') {
      // 本地文件可能已被 move 删除,尝试清理
      if (f.absolutePath) {
        try {
          if (fs.existsSync(f.absolutePath)) {
            fs.unlinkSync(f.absolutePath);
          }
        } catch {
          // ignore
        }
      }
      fileRepo.remove(f.id);
      deleted++;
    }
  }
  res.json({
    ok: true,
    data: fileRepo.list(),
    message: `已删除 ${deleted} 条已上传记录`,
  } satisfies ApiResponse);
});

/** 安全校验:仅允许 recordings 目录内文件 */
export function resolveMediaPath(relativePath: string): string | null {
  const settings = loadSettings();
  const root = path.resolve(settings.recordingsDir);
  const abs = path.resolve(root, relativePath);
  // 防止 /data/recordings2 之类的目录穿越
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(abs)) return null;
  if (!fs.statSync(abs).isFile()) return null;
  return abs;
}
