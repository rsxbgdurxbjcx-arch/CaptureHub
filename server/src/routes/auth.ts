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

authRouter.post('/login', (req, res) => {
  const schema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  });
  try {
    const { username, password } = schema.parse(req.body);
    const token = login(username, password);
    if (!token) {
      res.status(401).json({
        ok: false,
        error: '账号或密码错误',
      } satisfies ApiResponse);
      return;
    }
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
