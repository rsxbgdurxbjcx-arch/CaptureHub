/**
 * BotServerManager — 内置 Local Telegram Bot API Server 管理器
 *
 * 职责:
 * 1. 根据前端配置的 api-id / api-hash 自动拉起本地 telegram-bot-api 进程
 * 2. 健康检查(Health Check):周期性探测本地端口是否可连接
 * 3. 优雅关闭(Graceful Shutdown):收到 SIGTERM/SIGINT 时安全终止子进程
 * 4. 崩溃自动重启:子进程意外退出后自动重新拉起
 *
 * 本地服务器以 --local 模式运行,支持:
 * - 上传最大 2GB 文件(普通用户)/ 4GB(Premium 会员)
 * - 通过本地路径或 file:// URI 指定请求字段值上传(不走外部网络)
 *
 * 重要:telegram-bot-api(tdlib 官方实现)的日志级别参数是
 * `--verbosity=<0-5>`(2=warning),并不存在 `--log-level` 选项。
 * 传入未知选项会让服务器在解析参数时立即退出(exit code=1),
 * 表现为「服务器启动超时」。本模块已修正该参数,并在启动失败时
 * 抓取子进程 stderr 输出,把真实原因上报给前端。
 */
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PATHS } from '../config.js';
import { whichSync, sleep } from '../utils.js';

/** BotServerManager 配置 */
export interface BotServerConfig {
  apiId: string;
  apiHash: string;
  /** 本地监听端口,默认 8081 */
  port: number;
  /** telegram-bot-api 二进制路径 */
  binaryPath: string;
  /** Bot Token(用于健康检查) */
  botToken?: string;
}

/** 服务器运行状态 */
export type ServerStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error';

/** 健康检查结果 */
export interface HealthCheckResult {
  healthy: boolean;
  status: ServerStatus;
  port: number;
  pid: number | null;
  uptimeSec: number;
  lastError: string | null;
}

const DEFAULT_PORT = 8081;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const RESTART_DELAY_MS = 3_000;
const MAX_RESTART_COUNT = 5;
const STARTUP_TIMEOUT_MS = 30_000;
/** 保留最近 4000 字符的 stderr,用于定位启动失败原因 */
const STDERR_TAIL_LIMIT = 4000;

class BotServerManager {
  private child: ChildProcess | null = null;
  private status: ServerStatus = 'stopped';
  private currentConfig: BotServerConfig | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private restartCount = 0;
  private intentionalStop = false;
  /** 子进程 stderr 最近输出(定位启动失败原因) */
  private stderrTail = '';
  /** 服务器工作目录(存放数据库/文件缓存) */
  private readonly workDir: string;
  /** 临时文件目录(存放上传中的大文件,放在 data 卷下保证空间) */
  private readonly tempDir: string;

  constructor() {
    this.workDir = path.join(PATHS.data, 'telegram-bot-api');
    this.tempDir = path.join(this.workDir, 'tmp');
  }

  /** 获取当前状态(与前端 BotServerStatus 接口对齐) */
  getStatus() {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      port: this.currentConfig?.port ?? null,
      apiRoot: this.status === 'running' ? this.getApiRoot() : null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      restartCount: this.restartCount,
    };
  }

  /** 本地服务器基础 URL */
  getApiRoot(): string {
    const port = this.currentConfig?.port ?? DEFAULT_PORT;
    return `http://127.0.0.1:${port}`;
  }

  /** 检测 telegram-bot-api 二进制是否可用 */
  isBinaryAvailable(binaryPath?: string): boolean {
    const p = binaryPath || this.currentConfig?.binaryPath || 'telegram-bot-api';
    return whichSync(p);
  }

  /**
   * 启动本地 Bot API Server
   * 若已在运行且配置相同,则跳过;若配置变更,则先关闭再重启。
   */
  async start(config: BotServerConfig): Promise<void> {
    // 校验必要参数
    if (!config.apiId?.trim() || !config.apiHash?.trim()) {
      throw new Error('启动 Local Bot API Server 需要 api-id 和 api-hash');
    }
    if (!this.isBinaryAvailable(config.binaryPath)) {
      throw new Error(
        `telegram-bot-api 二进制未找到: ${config.binaryPath}\n` +
        `请安装 telegram-bot-api 或配置正确路径。`,
      );
    }

    // 若已有子进程(无论状态),先确保配置一致,否则清理后重启
    if (this.child && this.currentConfig) {
      if (this.status === 'running' && this.configEquals(this.currentConfig, config)) {
        console.log('[bot-server] 已在运行且配置未变,跳过启动');
        return;
      }
      console.log('[bot-server] 配置已变更或状态异常,重启服务器...');
      await this.stop();
    }

    this.intentionalStop = false;
    this.currentConfig = config;
    await this.spawnProcess();
  }

  /** 拉起 telegram-bot-api 子进程 */
  private async spawnProcess(): Promise<void> {
    const cfg = this.currentConfig!;
    this.status = 'starting';
    this.lastError = null;
    this.stderrTail = '';

    // 确保工作目录存在(含临时文件目录)
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.mkdirSync(this.tempDir, { recursive: true });

    // 启动前检查端口占用,给出明确错误
    if (await this.isPortInUse(cfg.port)) {
      this.status = 'error';
      this.lastError = `端口 ${cfg.port} 已被占用,请更换 Local Server Port 或释放该端口`;
      throw new Error(this.lastError);
    }

    const args = [
      `--api-id=${cfg.apiId.trim()}`,
      `--api-hash=${cfg.apiHash.trim()}`,
      '--local',
      `--http-port=${cfg.port}`,
      '--http-ip-address=127.0.0.1',
      `--dir=${this.workDir}`,
      // 临时文件目录放到 data 卷下:2GB/4GB 大文件需要同等大小的临时存储,
      // /tmp 位于容器可写层(可能容量受限或被 tmpfs 限制),data 卷空间更有保障
      `--temp-dir=${this.tempDir}`,
      // 注意:telegram-bot-api 只支持 --verbosity(0-5,2=warning),不支持 --log-level
      '--verbosity=2',
    ];

    console.log(`[bot-server] 启动 telegram-bot-api: ${cfg.binaryPath} ${args.join(' ')}`);

    try {
      this.child = spawn(cfg.binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (e) {
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : String(e);
      throw new Error(`无法启动 telegram-bot-api: ${this.lastError}`);
    }

    this.startedAt = Date.now();
    this.attachHandlers();

    // 等待服务器就绪;进程提前退出时立即失败并上报真实原因
    const ready = await this.waitForReady(STARTUP_TIMEOUT_MS);
    if (!ready) {
      if (this.intentionalStop) {
        this.status = 'stopped';
        throw new Error('Local Bot API Server 已停止');
      }
      this.status = 'error';
      if (!this.lastError) {
        this.lastError = `服务器启动超时(${STARTUP_TIMEOUT_MS / 1000}s 内未就绪)`;
        const detail = this.stderrTail.trim();
        if (detail) this.lastError += `\n${detail}`;
      }
      throw new Error(this.lastError || '服务器启动失败');
    }

    this.status = 'running';
    this.restartCount = 0;
    console.log(`[bot-server] 服务器已就绪: ${this.getApiRoot()} (pid=${this.child?.pid})`);

    // 启动周期性健康检查
    this.startHealthCheck();
  }

  /** 绑定子进程事件处理器 */
  private attachHandlers() {
    const child = this.child!;

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[bot-api] ${text}`);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) console.error(`[bot-api:err] ${line.trim()}`);
      }
    });

    child.on('error', (err) => {
      console.error('[bot-server] 子进程错误:', err.message);
      this.lastError = `无法启动 telegram-bot-api: ${err.message}`;
      this.status = 'error';
      this.child = null;
    });

    child.on('exit', (code, signal) => {
      console.log(`[bot-server] 子进程退出 code=${code} signal=${signal}`);
      this.child = null;
      this.stopHealthCheck();

      if (this.intentionalStop) {
        this.status = 'stopped';
        return;
      }

      // 启动阶段提前退出 → 立即记录真实原因并停止(不自动重启,由上层抛错)
      if (this.status === 'starting') {
        const detail = this.stderrTail.trim();
        this.status = 'error';
        this.lastError =
          `telegram-bot-api 启动失败 (exit code=${code ?? 'null'}` +
          `${signal ? `, signal=${signal}` : ''})` +
          (detail ? `\n${detail}` : '');
        return;
      }

      // 运行阶段意外退出 → 尝试自动重启
      if (this.restartCount < MAX_RESTART_COUNT) {
        this.restartCount++;
        console.log(`[bot-server] 意外退出,${RESTART_DELAY_MS / 1000}s 后自动重启 (第 ${this.restartCount} 次)`);
        this.status = 'error';
        setTimeout(() => {
          if (!this.intentionalStop && this.currentConfig) {
            this.spawnProcess().catch((e) => {
              console.error('[bot-server] 重启失败:', e);
            });
          }
        }, RESTART_DELAY_MS);
      } else {
        this.status = 'error';
        this.lastError = `自动重启次数已达上限 (${MAX_RESTART_COUNT}),请检查 api-id/api-hash 是否正确`;
        console.error('[bot-server] 自动重启次数已达上限,停止重试');
      }
    });
  }

  /** 等待服务器就绪(端口可连接 + API 可响应) */
  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 启动阶段进程已退出 → 立即失败
      if (!this.child) return false;
      if (await this.probeHealth()) return true;
      await sleep(500);
    }
    return false;
  }

  /** 探测本地服务器健康状态 */
  private async probeHealth(): Promise<boolean> {
    const cfg = this.currentConfig;
    if (!cfg) return false;
    try {
      // 用 getMe 接口探测(若配置了 bot token),否则直接探测端口连通性
      const url = cfg.botToken?.trim()
        ? `${this.getApiRoot()}/bot${cfg.botToken.trim()}/getMe`
        : this.getApiRoot();
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      // 任何 HTTP 响应都说明服务器已在监听:
      // 200 = token 有效;401/400 = token 无效但服务器运行中;404 = 无该路由但端口在监听
      return res.status > 0;
    } catch {
      return false;
    }
  }

  /** 检查本地端口是否已被占用 */
  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (used: boolean) => {
        socket.destroy();
        resolve(used);
      };
      socket.setTimeout(1500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, '127.0.0.1');
    });
  }

  /** 启动周期性健康检查 */
  private startHealthCheck() {
    this.stopHealthCheck();
    this.healthTimer = setInterval(async () => {
      if (this.status !== 'running') return;
      const healthy = await this.probeHealth();
      if (!healthy && !this.intentionalStop) {
        console.warn('[bot-server] 健康检查失败,标记为 error');
        this.status = 'error';
        this.lastError = '健康检查失败:服务器无响应';
      } else if (healthy && this.status !== 'running') {
        this.status = 'running';
        this.lastError = null;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /** 停止周期性健康检查 */
  private stopHealthCheck() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** 比较两份配置是否一致 */
  private configEquals(a: BotServerConfig, b: BotServerConfig): boolean {
    return (
      a.apiId === b.apiId &&
      a.apiHash === b.apiHash &&
      a.port === b.port &&
      a.binaryPath === b.binaryPath
    );
  }

  /** 优雅关闭服务器 */
  async stop(): Promise<void> {
    this.intentionalStop = true;
    this.stopHealthCheck();

    if (!this.child) {
      this.status = 'stopped';
      return;
    }

    console.log('[bot-server] 正在优雅关闭 telegram-bot-api...');

    // 先尝试 SIGTERM
    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore
    }

    // 等待最多 5 秒
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child) {
          try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
        }
        resolve();
      }, 5000);

      this.child?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.child = null;
    this.status = 'stopped';
    this.startedAt = null;
    console.log('[bot-server] 已关闭');
  }
}

export const botServerManager = new BotServerManager();
