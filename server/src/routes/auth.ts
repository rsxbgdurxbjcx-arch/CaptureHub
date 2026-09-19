import { Router } from 'express';
import { z } from 'zod';
import {
  login,
  logout,
  verifyToken,
  extractToken,
  getUsername,
  changeCredentials,
} from '../auth.js';
import type { ApiResponse } from '../types.js';

export const authRouter = Router();

// -- 登录尝试限流(防爆破):同 IP 15 分钟窗口内最多 10 次失败 --
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkLoginRateLimit(ip: string): { limited: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return { limited: false, retryAfterSec: 0 };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { limited: true, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { limited: false, retryAfterSec: 0 };
}

function recordLoginFailure(ip: string) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearLoginAttempts(ip: string) {
  loginAttempts.delete(ip);
}

// 定期清理过期条目,避免 map 无限增长
const loginRateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);
loginRateCleanupTimer.unref?.();

authRouter.post('/login', (req, res) => {
  const schema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  });
  try {
    const ip = req.ip || 'unknown';
    const rate = checkLoginRateLimit(ip);
    if (rate.limited) {
      res.status(429).json({
        ok: false,
        error: `登录尝试次数过多,请 ${Math.max(1, Math.ceil(rate.retryAfterSec / 60))} 分钟后再试`,
      } satisfies ApiResponse);
      return;
    }
    const { username, password } = schema.parse(req.body);
    const token = login(username, password);
    if (!token) {
      recordLoginFailure(ip);
      res.status(401).json({
        ok: false,
        error: '账号或密码错误',
      } satisfies ApiResponse);
      return;
    }
    clearLoginAttempts(ip);
    res.json({
      ok: true,
      data: { token, username },
      message: '登录成功',
    } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});

authRouter.post('/logout', (req, res) => {
  const token = extractToken(req.headers.authorization);
  if (token) logout(token);
  res.json({ ok: true, message: '已退出登录' } satisfies ApiResponse);
});

authRouter.get('/status', (req, res) => {
  const token = extractToken(req.headers.authorization);
  const authenticated = verifyToken(token);
  res.json({
    ok: true,
    data: {
      authenticated,
      username: authenticated ? getUsername() : null,
    },
  } satisfies ApiResponse);
});

const changeSchema = z.object({
  username: z.string().min(1),
  currentPassword: z.string().min(1),
  newPassword: z.string().optional(),
});

authRouter.post('/change-credentials', (req, res) => {
  const token = extractToken(req.headers.authorization);
  if (!verifyToken(token)) {
    res.status(401).json({ ok: false, error: '未登录' } satisfies ApiResponse);
    return;
  }
  try {
    const body = changeSchema.parse(req.body);
    const result = changeCredentials(
      body.username,
      body.currentPassword,
      body.newPassword,
    );
    if (!result.success) {
      res.status(400).json({
        ok: false,
        error: result.error || '修改失败',
      } satisfies ApiResponse);
      return;
    }
    // 重新登录获取新 token
    const newToken = login(
      body.username,
      body.newPassword || body.currentPassword,
    );
    res.json({
      ok: true,
      data: { token: newToken, username: body.username },
      message: '账号密码已修改，请重新登录',
    } satisfies ApiResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg } satisfies ApiResponse);
  }
});
