/**
 * TARS (Tencent Application Remote Service) 二进制编解码
 * 移植自 biliup crates/danmaku/src/codec/tars.rs 与
 * crates/biliup/src/downloader/live/huya_wup.rs 的最小实现
 *
 * 仅覆盖虎牙场景用到的子集:
 * - WUP getCdnTokenInfoEx 请求/响应 (uni-packet + map 载荷)
 * - 虎牙弹幕 WebSocket 消息 (WebSocketCommand / MessageNotice)
 *
 * int64 统一用 JS number 表达。虎牙 uid/消息类型等实际取值范围
 * 远小于 Number.MAX_SAFE_INTEGER (2^53), 精度安全。
 */

/** TARS 数据类型编号 (与协议规范一致) */
export enum TarsType {
  Int8 = 0,
  Int16 = 1,
  Int32 = 2,
  Int64 = 3,
  Float = 4,
  Double = 5,
  String1 = 6,
  String4 = 7,
  Map = 8,
  List = 9,
  StructBegin = 10,
  StructEnd = 11,
  Zero = 12,
  Bytes = 13,
}

/** TARS 输出流: 按 tag + 类型写入字段 */
export class TarsOutputStream {
  private buf: number[] = [];

  getBuffer(): Buffer {
    return Buffer.from(this.buf);
  }

  private writeHead(tag: number, type: TarsType) {
    if (tag < 15) {
      this.buf.push(((tag << 4) | type) & 0xff);
    } else {
      this.buf.push(0xf0 | type);
      this.buf.push(tag & 0xff);
    }
  }

  writeBool(tag: number, value: boolean) {
    this.writeInt8(tag, value ? 1 : 0);
  }

  writeInt8(tag: number, value: number) {
    if (value === 0) {
      this.writeHead(tag, TarsType.Zero);
    } else {
      this.writeHead(tag, TarsType.Int8);
      this.buf.push(value & 0xff);
    }
  }

  writeInt16(tag: number, value: number) {
    if (value >= -128 && value <= 127) {
      this.writeInt8(tag, value);
    } else {
      this.writeHead(tag, TarsType.Int16);
      const b = Buffer.alloc(2);
      b.writeInt16BE(value);
      this.buf.push(b[0], b[1]);
    }
  }

  writeInt32(tag: number, value: number) {
    if (value >= -32768 && value <= 32767) {
      this.writeInt16(tag, value);
    } else {
      this.writeHead(tag, TarsType.Int32);
      const b = Buffer.alloc(4);
      b.writeInt32BE(value);
      this.buf.push(b[0], b[1], b[2], b[3]);
    }
  }

  writeInt64(tag: number, value: number) {
    if (value >= -2147483648 && value <= 2147483647) {
      this.writeInt32(tag, value);
      return;
    }
    this.writeHead(tag, TarsType.Int64);
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(Math.trunc(value)));
    for (const byte of b) this.buf.push(byte);
  }

  writeString(tag: number, value: string) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length <= 255) {
      this.writeHead(tag, TarsType.String1);
      this.buf.push(bytes.length);
    } else {
      this.writeHead(tag, TarsType.String4);
      const b = Buffer.alloc(4);
      b.writeUInt32BE(bytes.length);
      this.buf.push(b[0], b[1], b[2], b[3]);
    }
    for (const byte of bytes) this.buf.push(byte);
  }

  writeBytes(tag: number, value: Buffer) {
    this.writeHead(tag, TarsType.Bytes);
    this.writeHead(0, TarsType.Int8);
    this.writeInt32(0, value.length);
    for (const byte of value) this.buf.push(byte);
  }

  /** 写入 map<string, bytes> (WUP uni-packet 载荷) */
  writeMapStrBytes(tag: number, entries: Array<[string, Buffer]>) {
    this.writeHead(tag, TarsType.Map);
    this.writeInt32(0, entries.length);
    for (const [key, value] of entries) {
      this.writeString(0, key);
      this.writeBytes(1, value);
    }
  }

  /** 写入空 map<string, string> (RequestPacket 的 context/status) */
  writeEmptyStrMap(tag: number) {
    this.writeHead(tag, TarsType.Map);
    this.writeInt32(0, 0);
  }

  writeStructBegin(tag: number) {
    this.writeHead(tag, TarsType.StructBegin);
  }

  writeStructEnd() {
    this.writeHead(0, TarsType.StructEnd);
  }
}

/** TARS 输入流: 按 tag 定位并解析字段, 自动跳过无关字段 */
export class TarsInputStream {
  private pos = 0;

  constructor(private readonly data: Buffer) {}

  position(): number {
    return this.pos;
  }

  private peekHead(): [number, TarsType] | null {
    if (this.pos >= this.data.length) return null;
    const byte = this.data[this.pos];
    const tag = (byte >> 4) & 0x0f;
    const typeId = byte & 0x0f;
    let actualTag = tag;
    if (tag >= 15) {
      if (this.pos + 1 >= this.data.length) return null;
      actualTag = this.data[this.pos + 1];
    }
    const type = typeId as TarsType;
    if (typeId > TarsType.Bytes) return null;
    return [actualTag, type];
  }

  private readHead(): [number, TarsType] | null {
    if (this.pos >= this.data.length) return null;
    const byte = this.data[this.pos];
    const tag = (byte >> 4) & 0x0f;
    const typeId = byte & 0x0f;
    this.pos += 1;
    let actualTag = tag;
    if (tag >= 15) {
      if (this.pos >= this.data.length) return null;
      actualTag = this.data[this.pos];
      this.pos += 1;
    }
    if (typeId > TarsType.Bytes) return null;
    return [actualTag, typeId as TarsType];
  }

  /** 定位到指定 tag; tag 已越过目标或遇到结构体结尾时返回 false */
  skipToTag(target: number): boolean {
    while (this.pos < this.data.length) {
      const head = this.peekHead();
      if (!head) break;
      const [tag, type] = head;
      if (type === TarsType.StructEnd) return false;
      if (tag === target) return true;
      if (tag > target) return false;
      this.readHead();
      this.skipField(type);
    }
    return false;
  }

  private skipField(type: TarsType) {
    switch (type) {
      case TarsType.Int8:
        this.pos += 1;
        break;
      case TarsType.Int16:
        this.pos += 2;
        break;
      case TarsType.Int32:
        this.pos += 4;
        break;
      case TarsType.Int64:
        this.pos += 8;
        break;
      case TarsType.Float:
        this.pos += 4;
        break;
      case TarsType.Double:
        this.pos += 8;
        break;
      case TarsType.String1: {
        if (this.pos < this.data.length) {
          const len = this.data[this.pos];
          this.pos += 1 + len;
        }
        break;
      }
      case TarsType.String4: {
        if (this.pos + 4 <= this.data.length) {
          const len = this.data.readUInt32BE(this.pos);
          this.pos += 4 + len;
        }
        break;
      }
      case TarsType.Map: {
        const size = this.readIntValue() ?? 0;
        for (let i = 0; i < size * 2; i++) {
          const head = this.readHead();
          if (!head) break;
          this.skipField(head[1]);
        }
        break;
      }
      case TarsType.List: {
        const size = this.readIntValue() ?? 0;
        for (let i = 0; i < size; i++) {
          const head = this.readHead();
          if (!head) break;
          this.skipField(head[1]);
        }
        break;
      }
      case TarsType.Bytes: {
        this.readHead();
        const size = this.readIntValue() ?? 0;
        this.pos += size;
        break;
      }
      case TarsType.StructBegin:
        this.skipToStructEnd();
        break;
      case TarsType.StructEnd:
      case TarsType.Zero:
        break;
    }
  }

  private skipToStructEnd() {
    for (;;) {
      const head = this.readHead();
      if (!head) break;
      if (head[1] === TarsType.StructEnd) break;
      this.skipField(head[1]);
    }
  }

  /** 读取一个带 head 的整数字段 (用于 map/list/bytes 的长度) */
  private readIntValue(): number | null {
    const head = this.readHead();
    if (!head) return null;
    return this.readIntBody(head[1]);
  }

  private readIntBody(type: TarsType): number | null {
    switch (type) {
      case TarsType.Zero:
        return 0;
      case TarsType.Int8:
        if (this.pos >= this.data.length) return null;
        return this.data.readInt8(this.pos++) ?? 0;
      case TarsType.Int16: {
        if (this.pos + 2 > this.data.length) return null;
        const v = this.data.readInt16BE(this.pos);
        this.pos += 2;
        return v;
      }
      case TarsType.Int32: {
        if (this.pos + 4 > this.data.length) return null;
        const v = this.data.readInt32BE(this.pos);
        this.pos += 4;
        return v;
      }
      case TarsType.Int64: {
        if (this.pos + 8 > this.data.length) return null;
        const v = Number(this.data.readBigInt64BE(this.pos));
        this.pos += 8;
        return v;
      }
      default:
        return null;
    }
  }

  readInt32(tag: number): number | null {
    if (!this.skipToTag(tag)) return null;
    const head = this.readHead();
    if (!head) return null;
    return this.readIntBody(head[1]);
  }

  readInt64(tag: number): number | null {
    return this.readInt32(tag);
  }

  private readStringBody(type: TarsType): string | null {
    let len: number;
    if (type === TarsType.String1) {
      if (this.pos >= this.data.length) return null;
      len = this.data[this.pos];
      this.pos += 1;
    } else if (type === TarsType.String4) {
      if (this.pos + 4 > this.data.length) return null;
      len = this.data.readUInt32BE(this.pos);
      this.pos += 4;
    } else {
      return null;
    }
    if (this.pos + len > this.data.length) return null;
    const s = this.data.subarray(this.pos, this.pos + len).toString('utf8');
    this.pos += len;
    return s;
  }

  readString(tag: number): string | null {
    if (!this.skipToTag(tag)) return null;
    const head = this.readHead();
    if (!head) return null;
    const s = this.readStringBody(head[1]);
    if (s === null) this.skipField(head[1]);
    return s;
  }

  private readBytesBody(): Buffer | null {
    if (!this.readHead()) return null;
    const size = this.readIntValue();
    if (size === null || size < 0) return null;
    if (this.pos + size > this.data.length) return null;
    const bytes = Buffer.from(this.data.subarray(this.pos, this.pos + size));
    this.pos += size;
    return bytes;
  }

  readBytes(tag: number): Buffer | null {
    if (!this.skipToTag(tag)) return null;
    const head = this.readHead();
    if (!head) return null;
    if (head[1] !== TarsType.Bytes) {
      this.skipField(head[1]);
      return null;
    }
    return this.readBytesBody();
  }

  /** 读取指定 tag 的结构体, 用回调读取内部字段 */
  readStruct<T>(tag: number, reader: (stream: TarsInputStream) => T): T | null {
    if (!this.skipToTag(tag)) return null;
    const head = this.readHead();
    if (!head) return null;
    if (head[1] !== TarsType.StructBegin) {
      this.skipField(head[1]);
      return null;
    }
    const result = reader(this);
    this.skipToStructEnd();
    return result;
  }

  /** 读取 map<string, bytes> (供 WUP 响应 uni-packet 使用) */
  readMapStrBytes(tag: number): Map<string, Buffer> | null {
    if (!this.skipToTag(tag)) return null;
    const head = this.readHead();
    if (!head || head[1] !== TarsType.Map) return null;
    const size = this.readIntValue() ?? 0;
    const result = new Map<string, Buffer>();
    for (let i = 0; i < size; i++) {
      const keyHead = this.readHead();
      if (!keyHead) return null;
      const key = this.readStringBody(keyHead[1]);
      const valueHead = this.readHead();
      if (key === null || !valueHead) return null;
      if (valueHead[1] !== TarsType.Bytes) {
        this.skipField(valueHead[1]);
        return null;
      }
      const value = this.readBytesBody();
      if (value === null) return null;
      result.set(key, value);
    }
    return result;
  }
}
