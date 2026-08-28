import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import { streamersRouter } from './routes/streamers.js';
import { filesRouter, resolveMediaPath } from './routes/files.js';
import { postprocessRouter } from './routes/postprocess.js';
import { settingsRouter } from './routes/settings.js';
import { systemRouter } from './routes/system.js';
import { authRouter } from './routes/auth.js';
import { verifyToken, extractToken } from './auth.js';
import type { ApiResponse } from './types.js';

export function createApp() {
  const app = express();

  // 安全响应头:防 MIME 嗅探、iframe 点击劫持,以及 ?token= 经 referrer 泄漏到第三方
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // CORS:默认同源部署,不发放跨域头;
  // 仅当显式配置 CORS_ORIGIN(逗号分隔的允许来源)时才开启跨域。
  const corsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins }));
  }
  app.use(express.json({ limit: '2mb' }));

  // -- 公开路由（无需认证）--
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, message: 'CaptureHub ok', version: 'v2.4.1' });
  });

  app.use('/api/auth', authRouter);

  // -- 认证中间件 --
  app.use('/api', (req, res, next) => {
    // auth 路由已注册，跳过
    if (req.path.startsWith('/auth') || req.path === '/health') {
      return next();
    }
    // 优先从 Authorization header 取 token；
    // GET 请求（如 <img> 加载直播快照）允许通过 ?token= 传入
    const token =
      extractToken(req.headers.authorization) ||
      (req.method === 'GET' ? (req.query.token as string | undefined) : undefined);
    if (!verifyToken(token)) {
      res.status(401).json({
        ok: false,
        error: '登录已过期',
      } satisfies ApiResponse);
      return;
    }
    next();
  });

  // -- 受保护 API 路由 --
  app.use('/api/streamers', streamersRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/postprocess', postprocessRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/system', systemRouter);

  // -- 媒体预览(需鉴权:Bearer 或 ?token=;HTML5 <video> 无法携带 header,故支持 query token)--
  app.get('/media/:filePath(*)', (req, res) => {
    const token =
      extractToken(req.headers.authorization) ||
      (req.method === 'GET' ? (req.query.token as string | undefined) : undefined);
    if (!verifyToken(token)) {
      res.status(401).json({ ok: false, error: '登录已过期' } satisfies ApiResponse);
      return;
    }
    const rel = String(req.params.filePath || '').replace(/^\/+/, '');
    if (!rel) {
      res.status(400).json({ ok: false, error: '缺少文件路径' });
      return;
    }
    const abs = resolveMediaPath(rel);
    if (!abs) {
      res.status(404).json({ ok: false, error: '文件不存在' });
      return;
    }
    res.sendFile(abs);
  });

  // -- 静态文件 + SPA --
  const distDir = PATHS.clientDist;
  const indexPath = path.join(distDir, 'index.html');
  const hasClient = fs.existsSync(indexPath);

  console.log(`[app] clientDist=${distDir} hasClient=${hasClient}`);

  if (hasClient) {
    // 所有非 API / 非 media 请求 → 优先匹配静态文件
    app.use(express.static(distDir, { index: 'index.html', maxAge: '1h' }));

    // SPA 回退（客户端路由如 /streamers /files 等）
    app.get(/^\/(?!api|media).*/, (req, res) => {
      res.sendFile(indexPath);
    });
  } else {
    app.get(/^\/(?!api|media).*/, (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CaptureHub</title><style>body{background:#f8f9fa;color:#1a1a1a;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column}
a{color:#1a1a1a}h2{margin:0 0 8px}p{color:#888;font-size:14px}</style></head>
<body><h2>CaptureHub server running</h2><p>前端未构建。请运行 <code>npm run build -w client</code> 或使用 <code>npm run dev:client</code>。</p>
<p>API 端点：<a href="/api/health">/api/health</a></p></body></html>`);
    });
  }

  // -- 错误处理 --
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error('[error]', err);
      res.status(500).json({ ok: false, error: err.message || '服务器错误' });
    },
  );

  return app;
}
