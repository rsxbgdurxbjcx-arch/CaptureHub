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
  /** 被接管的残留实例 pid(pid 文件记录;child 为 null 时用于状态展示) */
  private adoptedPid: number | null = null;
  /** 连续健康检查失败计数(防单次抖动误判 error) */
  private healthCheckFailures = 0;
  /** 服务器工作目录(存放数据库/文件缓存) */
  private readonly workDir: string;
  /** 临时文件目录(存放上传中的大文件,放在 data 卷下保证空间) */
  private readonly tempDir: string;
  /** pid 文件路径(记录最后一次 spawn 的进程,用于残留实例接管/清理) */
  private readonly pidFilePath: string;

  constructor() {
    this.workDir = path.join(PATHS.data, 'telegram-bot-api');
    this.tempDir = path.join(this.workDir, 'tmp');
    // pid 文件:记录本管理器最后一次 spawn 的 telegram-bot-api 进程,
    // 用于识别"管理状态丢失但进程仍在运行"的残留实例(如容器内状态错乱后无法停止),
    // 实现端口占用时自动接管/清理,而不是永远报"端口已被占用"
    this.pidFilePath = path.join(this.workDir, 'manager.pid');
  }

  /** 获取当前状态(与前端 BotServerStatus 接口对齐) */
  getStatus() {
    return {
      status: this.status,
      pid: this.child?.pid ?? this.adoptedPid,
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
   *
   * 端口被占用时的智能处理(修复"端口 8081 已被占用"死循环):
   * - 若占用者是本管理器之前 spawn 且仍存活的实例(依据 pid 文件)→
   *   直接接管并复用,状态恢复为 running,不再报错;
   * - 否则给出明确错误(含容器内清理命令)。
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

    // 端口占用检测:若占用者是我们之前 spawn 的残留实例(管理状态丢失但进程存活,
    // 例如健康检查误判/异常退出后进程未真正终止),直接接管,而非反复报错
    if (await this.isPortInUse(config.port)) {
      const pid = this.readPidFile();
      if (pid && this.isProcessAlive(pid)) {
        // 接管前验证:仅当占用者能正常响应(getMe/端口)时才视为本系统的 bot server
        const prev = this.currentConfig;
        this.currentConfig = config;
        const healthy = await this.probeHealth();
        if (!healthy) {
          this.currentConfig = prev ?? config;
          this.status = 'error';
          this.lastError =
            `端口 ${config.port} 已被占用,且占用者无法响应(pid=${pid}),` +
            `可能为其他进程或残留僵尸实例`;
          throw new Error(
            `${this.lastError}\n` +
            `可在容器内执行: pkill -f telegram-bot-api ` +
            `(或 docker exec capturehub pkill -f telegram-bot-api)`,
          );
        }
        console.log(
          `[bot-server] 检测到先前启动的残留实例 (pid=${pid}) 仍监听端口 ${config.port},已接管`,
        );
        this.status = 'running';
        this.lastError = null;
        this.startedAt = Date.now();
        this.restartCount = 0;
        this.adoptedPid = pid;
        this.startHealthCheck();
        return;
      }
      // 不是我们的实例(或 pid 记录丢失):给出明确错误与处置指引
      this.status = 'error';
      this.lastError = `端口 ${config.port} 已被占用,请更换 Local Server Port 或释放该端口`;
      throw new Error(
        `${this.lastError}\n` +
        `若为本系统残留的 telegram-bot-api 实例,可在容器内执行: pkill -f telegram-bot-api ` +
        `(或 docker exec capturehub pkill -f telegram-bot-api)`,
      );
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

    // 启动前检查端口占用,给出明确错误(兜底:正常路径已在 start() 中接管/处理)
    if (await this.isPortInUse(cfg.port)) {
      this.status = 'error';
      this.lastError = `端口 ${cfg.port} 已被占用,请更换 Local Server Port 或释放该端口`;
      throw new Error(
        `${this.lastError}\n` +
        `若为本系统残留的 telegram-bot-api 实例,可在容器内执行: ` +
        `docker exec capturehub pkill -f telegram-bot-api`,
      );
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
    this.writePidFile();

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
    this.healthCheckFailures = 0;
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
      this.clearPidFile();
    });

    child.on('exit', (code, signal) => {
      console.log(`[bot-server] 子进程退出 code=${code} signal=${signal}`);
      this.child = null;
      this.clearPidFile();
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
      if (this.status !== 'running' && this.status !== 'error') return;
      const healthy = await this.probeHealth();
      if (healthy) {
        this.healthCheckFailures = 0;
        if (this.status !== 'running') {
          this.status = 'running';
          this.lastError = null;
        }
      } else if (!this.intentionalStop) {
        // 连续 3 次(约 45s)失败才标记 error:
        // 大文件上传期间 Local Server 繁忙/getMe 偶发超时属于正常抖动,
        // 单次失败不应误判(旧逻辑会把"运行中但进程活着"的实例标记为 error)
        this.healthCheckFailures++;
        if (this.healthCheckFailures >= 3 && this.status === 'running') {
          console.warn('[bot-server] 健康检查连续失败,标记为 error');
          this.status = 'error';
          this.lastError = '健康检查失败:服务器无响应';
        }
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
      // 未受管实例(接管场景/管理状态丢失):依据 pid 文件清理残留进程
      const pid = this.readPidFile();
      if (pid && this.isProcessAlive(pid)) {
        console.log(`[bot-server] 终止未受管的先前实例 (pid=${pid})...`);
        await this.killPid(pid);
      }
      // 仅当进程已退出(或从未记录)才清除 pid 文件;仍存活则保留供下次启动接管
      if (!pid || !this.isProcessAlive(pid)) {
        this.clearPidFile();
        this.adoptedPid = null;
      }
      this.status = 'stopped';
      this.startedAt = null;
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
    this.clearPidFile();
    this.adoptedPid = null;
    this.status = 'stopped';
    this.startedAt = null;
    console.log('[bot-server] 已关闭');
  }

  /* ---- pid 文件与残留实例处理 ---- */

  /** 写入当前受管子进程的 pid 文件 */
  private writePidFile() {
    try {
      fs.writeFileSync(this.pidFilePath, String(this.child?.pid ?? ''), 'utf8');
    } catch {
      // ignore
    }
  }

  /** 读取 pid 文件(不存在/非法返回 null) */
  private readPidFile(): number | null {
    try {
      const n = parseInt(fs.readFileSync(this.pidFilePath, 'utf8').trim(), 10);
      return Number.isFinite(n) && n > 1 ? n : null;
    } catch {
      return null;
    }
  }

  /** 清除 pid 文件 */
  private clearPidFile() {
    try {
      fs.unlinkSync(this.pidFilePath);
    } catch {
      // ignore
    }
  }

  /** 判断进程是否存活(kill(pid, 0);EPERM 表示存在但无权限,也算存活) */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /** 终止指定 pid 的进程(SIGTERM → 3s 后 SIGKILL),不依赖 exit 事件 */
  private async killPid(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    await sleep(3000);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
}

export const botServerManager = new BotServerManager();
