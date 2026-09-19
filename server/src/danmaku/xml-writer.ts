/**
 * 弹幕 XML 写入器 — B 站兼容格式
 * 移植自 biliup crates/danmaku/src/output/xml.rs
 *
 * 输出结构:
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <i>
 *     <d p="相对秒,1,25,颜色,时间戳,0,uid,0" timestamp uid user>内容</d>
 *   </i>
 *
 * 消息先在内存缓冲, 每 10 秒或缓冲超过 256KB 时刷盘;
 * finalize 时补 </i> 收尾; 一条消息都没有时删除空文件。
 */
import fs from 'node:fs';

const FLUSH_INTERVAL_MS = 10_000;
const MAX_PENDING_BYTES = 256 * 1024;

/** XML 文本节点转义 */
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** XML 属性值转义 */
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

export class XmlWriter {
  readonly filePath: string;
  private fd: number | null = null;
  private pending: string[] = [];
  private pendingBytes = 0;
  private messageCount = 0;
  private startedAt = Date.now();
  private flushTimer: NodeJS.Timeout;
  private finalized = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'w');
    try {
      fs.writeSync(this.fd, '<?xml version="1.0" encoding="UTF-8"?>\n<i>\n');
    } catch (e) {
      console.warn(`[danmaku] 写入 XML 头失败: ${e instanceof Error ? e.message : e}`);
    }
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /** 写入一条弹幕消息 */
  writeChat(msg: {
    content: string;
    name: string;
    uid: number;
    color: number;
    timestamp: Date;
  }): void {
    if (this.finalized) return;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const tsSec = Math.floor(msg.timestamp.getTime() / 1000);
    const uid = Number.isFinite(msg.uid) ? msg.uid : 0;
    const p = `${elapsed.toFixed(3)},1,25,${msg.color},${tsSec},0,${uid},0`;
    this.write(
      `\t<d p="${p}" timestamp="${tsSec}" uid="${uid}" user="${escapeAttr(msg.name)}">${escapeText(msg.content)}</d>\n`,
    );
    this.messageCount += 1;
  }

  private write(chunk: string): void {
    this.pending.push(chunk);
    this.pendingBytes += Buffer.byteLength(chunk, 'utf8');
    if (this.pendingBytes >= MAX_PENDING_BYTES) this.flush();
  }

  /** 将缓冲内容刷入磁盘 */
  flush(): void {
    if (!this.fd || this.pending.length === 0) return;
    const data = this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;
    try {
      fs.writeSync(this.fd, data);
    } catch (e) {
      console.warn(`[danmaku] 写入 XML 失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * 收尾: 补 </i>、关闭文件;
   * 没有任何消息时删除空文件 (与 biliup 行为一致)。
   */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    clearInterval(this.flushTimer);
    this.flush();
    try {
      if (this.fd !== null) {
        fs.writeSync(this.fd, '</i>\n');
        fs.closeSync(this.fd);
      }
    } catch (e) {
      console.warn(`[danmaku] 收尾 XML 失败: ${e instanceof Error ? e.message : e}`);
    }
    this.fd = null;
    if (this.messageCount === 0) {
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        // ignore: 文件可能已不存在
      }
    }
  }
}
