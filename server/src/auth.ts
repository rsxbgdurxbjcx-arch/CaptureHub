/**
 * CaptureHub 登录认证系统
 * - 初始账号: capturehub / admin
 * - 支持在 Web UI 设置中修改账号密码
 * - 使用 scrypt 哈希存储密码
 * - 基于 token 的会话管理
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from './config.js';

const AUTH_FILE = path.join(PATHS.data, 'auth.json');

interface AuthData {
  username: string;
  passwordHash: string;
  salt: string;
}

interface Session {
  token: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

// 登录后永不过期(仅在显式登出/修改密码后失效)
const SESSION_TTL = Number.MAX_SAFE_INTEGER;
const sessions = new Map<string, Session>();

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function loadAuth(): AuthData {
  ensureDirs();
  if (!fs.existsSync(AUTH_FILE)) {
    // 初始化默认账号: capturehub / admin
    const salt = generateSalt();
    const auth: AuthData = {
      username: 'capturehub',
      passwordHash: hashPassword('admin', salt),
      salt,
    };
    saveAuth(auth);
    return auth;
  }
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as AuthData;
  } catch {
    const salt = generateSalt();
    const auth: AuthData = {
      username: 'capturehub',
      passwordHash: hashPassword('admin', salt),
      salt,
    };
    saveAuth(auth);
    return auth;
  }
}

function saveAuth(auth: AuthData) {
  ensureDirs();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
}

/** 验证登录，成功返回 token */
export function login(username: string, password: string): string | null {
  const auth = loadAuth();
  if (username !== auth.username) return null;
  const hash = hashPassword(password, auth.salt);
  if (hash !== auth.passwordHash) return null;

  // 清理过期 session
  cleanupSessions();

  const token = generateToken();
  const now = Date.now();
  sessions.set(token, {
    token,
    username,
    createdAt: now,
    expiresAt: now + SESSION_TTL,
  });
  return token;
}

/** 注销 token */
export function logout(token: string): void {
  sessions.delete(token);
}

/** 验证 token 是否有效 */
export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** 获取当前用户名 */
export function getUsername(): string {
  return loadAuth().username;
}

/** 修改账号密码 */
export function changeCredentials(
  newUsername: string,
  currentPassword: string,
  newPassword?: string,
): { success: boolean; error?: string } {
  const auth = loadAuth();
  // 验证当前密码
  const currentHash = hashPassword(currentPassword, auth.salt);
  if (currentHash !== auth.passwordHash) {
    return { success: false, error: '当前密码错误' };
  }

  const updated: AuthData = {
    username: newUsername.trim() || auth.username,
    passwordHash: newPassword
      ? hashPassword(newPassword, auth.salt)
      : auth.passwordHash,
    salt: auth.salt,
  };
  saveAuth(updated);

  // 清除所有 session，强制重新登录
  sessions.clear();
  return { success: true };
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

/** 从 Authorization header 提取 token */
export function extractToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return authHeader;
}
