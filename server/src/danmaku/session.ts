/**
 * 弹幕录制会话 — 连接管理 / 心跳 / 自动重连 / XML 输出
 * 移植自 biliup crates/danmaku/src/client.rs 的生命周期管理
 *
 * - 每个录制会话对应一个 DanmakuSession, 后台循环维护连接;
 * - 连接异常时 30 秒后自动重连, 直至会话被停止;
 * - 录制切片轮转时 rollTo() 切换到与视频段同名的 XML 文件;
 * - stop() 收尾 (补 </i>、空文件删除)。
 */
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'undici';
import { XmlWriter } from './xml-writer.js';
import { sanitizeDanmakuText } from './filter.js';
import * as biliProtocol from './protocols/bilibili.js';
import * as douyuProtocol from './protocols/douyu.js';
import * as huyaProtocol from './protocols/huya.js';
import type { ChatMessage } from './types.js';

/** 支持弹幕录制的平台 */
export type DanmakuPlatform = 'douyu' | 'huya' | 'bilibili';

const RECONNECT_DELAY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface DanmakuSessionOptions {
  streamerId: string;
  platform: DanmakuPlatform;
  roomId: string;
  videoPath: string;
}

/** 由视频段路径推导弹幕 XML 路径 (同目录同名, 扩展名换为 .xml) */
export function xmlPathOf(videoPath: string): string {
  const ext = path.extname(videoPath);
  return videoPath.slice(0, videoPath.length - ext.length) + '.xml';
}

export class DanmakuSession {
  private readonly streamerId: string;
  private readonly platform: DanmakuPlatform;
  private readonly roomId: string;

  private writer: XmlWriter | null = null;
  private stopped = false;
  private socket: net.Socket | WebSocket | null = null;
  /** 中断当前连接等待 (stop 时调用, 使 runLoop 立即继续) */
  private wakeConnection: (() => void) | null = null;
  /** 中断重连等待 */
  private wakeSleep: (() => void) | null = null;

  constructor(opts: DanmakuSessionOptions) {
    this.streamerId = opts.streamerId;
    this.platform = opts.platform;
    this.roomId = opts.roomId;
    this.openWriter(opts.videoPath);
    void this.runLoop();
  }

  /** 切换到新的视频段 (录制切片时调用) */
  rollTo(videoPath: string): void {
    if (this.stopped) return;
    this.writer?.finalize();
    this.openWriter(videoPath);
  }

  /** 停止会话并收尾 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.wakeSleep?.();
    this.wakeConnection?.();
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      try {
        if (sock instanceof net.Socket) sock.destroy();
        else sock.close();
      } catch {
        // ignore
      }
    }
    this.writer?.finalize();
    this.writer = null;
  }

  private openWriter(videoPath: string): void {
    try {
      this.writer = new XmlWriter(xmlPathOf(videoPath));
    } catch (e) {
      console.warn(
        `[danmaku:${this.platform}] 创建弹幕文件失败: ${e instanceof Error ? e.message : e}`,
      );
      this.writer = null;
    }
  }

  private appendChat(msg: ChatMessage): void {
    // 屏蔽所有表情/emoji: 剥离 emoji 与文本表情占位符, 过滤后为空则丢弃整条
    const content = sanitizeDanmakuText(msg.content);
    if (!content) return;
    msg.content = content;
    this.writer?.writeChat(msg);
  }

  private log(msg: string): void {
    console.log(`[danmaku:${this.platform}] streamer=${this.streamerId} ${msg}`);
  }

  private warn(msg: string): void {
    console.warn(`[danmaku:${this.platform}] streamer=${this.streamerId} ${msg}`);
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectAndReceive();
      } catch (e) {
        if (!this.stopped) {
          this.warn(`连接失败: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (this.stopped) break;
      this.log('连接断开, 30 秒后重连');
      await this.interruptibleSleep(RECONNECT_DELAY_MS);
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSleep = null;
        resolve();
      }, ms);
      this.wakeSleep = () => {
        clearTimeout(timer);
        this.wakeSleep = null;
        resolve();
      };
    });
  }

  private connectAndReceive(): Promise<void> {
    if (this.platform === 'huya') return this.runHuyaConnection();
    if (this.platform === 'bilibili') return this.runBilibiliConnection();
    return this.runDouyuConnection();
  }

  /* ---------------- WebSocket 类协议 (虎牙 / B站) ---------------- */

  private async runHuyaConnection(): Promise<void> {
    const conn = await huyaProtocol.buildConnectionInfo(this.roomId);
    if (this.stopped) return;
    await this.runWsConnection({
      url: conn.url,
      headers: conn.headers,
      registration: conn.registration,
      heartbeat: huyaProtocol.HUYA_HEARTBEAT,
      heartbeatIntervalMs: huyaProtocol.HUYA_HEARTBEAT_INTERVAL_MS,
      decode: huyaProtocol.decodeHuyaMessages,
    });
  }

  private async runBilibiliConnection(): Promise<void> {
    const conn = await biliProtocol.buildConnectionInfo(this.roomId);
    if (this.stopped) return;
    await this.runWsConnection({
      url: conn.url,
      headers: conn.headers,
      registration: conn.registration,
      heartbeat: biliProtocol.BILI_HEARTBEAT,
      heartbeatIntervalMs: biliProtocol.BILI_HEARTBEAT_INTERVAL_MS,
      decode: biliProtocol.decodeBiliMessages,
    });
  }

  /** 通用 WebSocket 连接循环: 认证注册 → 周期心跳 → 解码回调; 断开/出错时结束本次连接 */
  private runWsConnection(opts: {
    url: string;
    headers: Record<string, string>;
    registration: Buffer;
    heartbeat: Buffer;
    heartbeatIntervalMs: number;
    decode: (buf: Buffer) => ChatMessage[];
  }): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        clearTimeout(connectTimer);
        this.wakeConnection = null;
        resolve();
      };
      this.wakeConnection = finish;

      const ws = new WebSocket(opts.url, { headers: opts.headers });
      this.socket = ws;
      ws.binaryType = 'arraybuffer';

      const connectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      }, CONNECT_TIMEOUT_MS);
      connectTimer.unref();

      heartbeatTimer = setInterval(() => {
        if (!this.stopped && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(opts.heartbeat);
          } catch {
            // ignore: 心跳失败由后续 close/error 触发重连
          }
        }
      }, opts.heartbeatIntervalMs);
      heartbeatTimer.unref();

      ws.addEventListener('open', () => {
        this.log('已连接');
        try {
          ws.send(opts.registration);
        } catch {
          // ignore
        }
      });

      ws.addEventListener('message', (ev) => {
        const data = ev.data;
        if (!(data instanceof ArrayBuffer)) return;
        for (const chat of opts.decode(Buffer.from(data))) {
          this.appendChat(chat);
        }
      });

      ws.addEventListener('error', () => {
        finish();
      });
      ws.addEventListener('close', () => {
        finish();
      });
    });
  }

  /* ---------------- 斗鱼: 原始 TCP + STT ---------------- */

  private async runDouyuConnection(): Promise<void> {
    const packets = douyuProtocol.buildRegistrationPackets(this.roomId);
    let connected = false;
    for (const endpoint of douyuProtocol.DOUYU_TCP_ENDPOINTS) {
      if (this.stopped) return;
      connected = await this.runDouyuSocket(endpoint, packets);
      if (connected || this.stopped) return;
    }
    throw new Error('斗鱼弹幕 TCP 端点全部连接失败');
  }

  /** 连接单个斗鱼弹幕端点; 返回是否曾成功建立连接 */
  private runDouyuSocket(endpoint: string, packets: Buffer[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const { host, port } = douyuProtocol.parseEndpoint(endpoint);
      let connected = false;
      let settled = false;
      let recvBuffer = Buffer.alloc(0);
      let heartbeatTimer: NodeJS.Timeout | null = null;

      const sock = new net.Socket();
      const finish = () => {
        if (settled) return;
        settled = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        clearTimeout(connectTimer);
        this.wakeConnection = null;
        resolve(connected);
      };
      this.wakeConnection = finish;
      this.socket = sock;

      const connectTimer = setTimeout(() => {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      }, CONNECT_TIMEOUT_MS);
      connectTimer.unref();

      sock.on('connect', () => {
        connected = true;
        clearTimeout(connectTimer);
        this.log(`已连接 ${endpoint}`);
        for (const packet of packets) {
          try {
            sock.write(packet);
          } catch {
            // ignore
          }
        }
        heartbeatTimer = setInterval(() => {
          if (!this.stopped) {
            try {
              sock.write(douyuProtocol.DOUYU_HEARTBEAT);
            } catch {
              // ignore
            }
          }
        }, douyuProtocol.DOUYU_HEARTBEAT_INTERVAL_MS);
        heartbeatTimer.unref();
      });

      sock.on('data', (chunk: Buffer) => {
        recvBuffer = Buffer.concat([recvBuffer, chunk]);
        for (;;) {
          if (recvBuffer.length < 12) break;
          const frameLength = recvBuffer.readUInt32LE(0);
          if (frameLength < 8 || frameLength > MAX_FRAME_BYTES) {
            // 帧头异常: 丢弃缓冲, 等待重连
            recvBuffer = Buffer.alloc(0);
            break;
          }
          if (recvBuffer.length < 4 + frameLength) break;
          const frame = recvBuffer.subarray(0, 4 + frameLength);
          recvBuffer = recvBuffer.subarray(4 + frameLength);
          for (const chat of douyuProtocol.parseMessages(frame)) {
            this.appendChat(chat);
          }
        }
      });

      sock.on('error', () => {
        // 连接错误: destroy 触发 close 后统一收尾
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      });
      sock.on('close', finish);

      try {
        sock.connect({ host, port });
      } catch {
        finish();
      }
    });
  }
}
