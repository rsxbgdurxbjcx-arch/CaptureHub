import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';

export function nowIso() {
  return new Date().toISOString();
}

export function safeName(input: string, fallback = 'unknown') {
  const cleaned = (input || fallback)
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

export function formatStamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 03:00:00 / 180 / 180m / 3h → 秒 */
export function parseDurationToSeconds(input: string | number): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(0, Math.floor(input));
  }
  const s = String(input || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s) * 60; // 纯数字按分钟
  if (/^\d+s$/i.test(s)) return Number(s.slice(0, -1));
  if (/^\d+m$/i.test(s)) return Number(s.slice(0, -1)) * 60;
  if (/^\d+h$/i.test(s)) return Number(s.slice(0, -1)) * 3600;
  const m = s.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (m) {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  const m2 = s.match(/^(\d+):(\d{2})$/);
  if (m2) {
    return Number(m2[1]) * 60 + Number(m2[2]);
  }
  return 0;
}

export function secondsToHms(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(r)}`;
}

/** 文件大小字符串(MB) → 字节数,空字符串返回 0 */
export function parseFileSizeToBytes(input: string | number): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(0, Math.floor(input * 1024 * 1024));
  }
  const s = String(input || '').trim();
  if (!s) return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 1024 * 1024);
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function pathExists(p: string) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function whichSync(cmd: string): boolean {
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    return pathExists(cmd);
  }
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE').split(';')
      : [''];
  const paths = (process.env.PATH || '').split(path.delimiter);
  for (const dir of paths) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (pathExists(full)) return true;
    }
  }
  return false;
}

export function runCommand(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
  } = {},
): {
  child: ReturnType<typeof spawn>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const bind = (
    stream: NodeJS.ReadableStream | null,
    cb?: (line: string) => void,
  ) => {
    if (!stream || !cb) return;
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) cb(line);
      }
    });
    stream.on('end', () => {
      if (buf.trim() && cb) cb(buf);
    });
  };

  bind(child.stdout, opts.onStdout);
  bind(child.stderr, opts.onStderr);

  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', () => resolve({ code: 1, signal: null }));
  });

  return { child, done };
}

export function newId(prefix: string) {
  return `${prefix}_${nanoid(10)}`;
}

export function assert(assertion: unknown, msg?: string): asserts assertion {
  if (!assertion) {
    throw new Error(msg);
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
