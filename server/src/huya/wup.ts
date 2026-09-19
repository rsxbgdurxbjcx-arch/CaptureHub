/**
 * 虎牙 WUP (getCdnTokenInfoEx) 请求所需的最小 TARS 编解码
 * 移植自 biliup crates/biliup/src/downloader/live/huya_wup.rs
 *
 * 结构:
 * - TarsV3 uni-packet: map { "tReq": <HUYA.GetCdnTokenExReq 字节> }
 * - RequestPacket: iVersion=3 / sServantName=liveui / sFuncName=getCdnTokenInfoEx
 * - 响应: 跳过 4 字节长度头后解析 RequestPacket, sBuffer(tag7) 内为
 *   map { "tRsp": <HUYA.GetCdnTokenExRsp 字节> }, sFlvToken 在结构体 tag 0
 */
import { TarsInputStream, TarsOutputStream } from '../codec/tars.js';

export const WUP_MAIN_URL = 'https://wup.huya.com';
export const WUP_YST_URL = 'https://snmhuya.yst.aisee.tv/liveui/getCdnTokenInfoEx';

/** 生成随机的虎牙客户端 sHuYaUA (对应 biliup random_hyapp_ua) */
export function randomHyappUa(): string {
  const configs: Array<[string, string, boolean]> = [
    ['adr', '13.1.0', true],
    ['ios', '13.1.0', false],
    ['huya_nftv', '2.6.10', true],
    ['pc_exe', '7000000', false],
  ];
  const [platform, version, android] =
    configs[Math.floor(Math.random() * configs.length)];
  if (android) {
    const build = Math.floor(Math.random() * 2001) + 3000; // 3000..=5000
    const apiLevel = Math.floor(Math.random() * 9) + 28; // 28..=36
    return `${platform}&${version}.${build}&official&${apiLevel}`;
  }
  return `${platform}&${version}&official`;
}

/** 编码 getCdnTokenInfoEx 请求体 (4 字节长度头 + TarsV3 uni-packet) */
export function encodeGetCdnTokenEx(streamName: string, huyaUa: string): Buffer {
  // HUYA.GetCdnTokenExReq, 写在 tag 0
  const req = new TarsOutputStream();
  req.writeStructBegin(0);
  req.writeString(0, ''); // sFlvUrl
  req.writeString(1, streamName); // sStreamName
  req.writeInt32(2, 0); // iLoopTime
  req.writeStructBegin(3); // tId: HUYA.UserId
  req.writeInt64(0, 0); // lUid
  req.writeString(1, ''); // sGuid
  req.writeString(2, ''); // sToken
  req.writeString(3, huyaUa); // sHuYaUA
  req.writeString(4, ''); // sCookie
  req.writeInt32(5, 0); // iTokenType
  req.writeString(6, ''); // sDeviceId
  req.writeString(7, ''); // sQIMEI
  req.writeStructEnd();
  req.writeInt32(4, 66); // iAppId
  req.writeStructEnd();

  // TarsV3 载荷: map { "tReq": <req 字节> }
  const payload = new TarsOutputStream();
  payload.writeMapStrBytes(0, [['tReq', req.getBuffer()]]);

  // RequestPacket
  const packet = new TarsOutputStream();
  packet.writeInt16(1, 3); // iVersion = 3
  packet.writeInt8(2, 0); // cPacketType
  packet.writeInt32(3, 0); // iMessageType
  packet.writeInt32(4, 1); // iRequestId
  packet.writeString(5, 'liveui'); // sServantName
  packet.writeString(6, 'getCdnTokenInfoEx'); // sFuncName
  packet.writeBytes(7, payload.getBuffer()); // sBuffer
  packet.writeInt32(8, 0); // iTimeout
  packet.writeEmptyStrMap(9); // context
  packet.writeEmptyStrMap(10); // status

  const packetBuf = packet.getBuffer();
  const out = Buffer.alloc(4 + packetBuf.length);
  out.writeUInt32BE(4 + packetBuf.length, 0);
  packetBuf.copy(out, 4);
  return out;
}

/** 从 getCdnTokenInfoEx 响应中解出 sFlvToken */
export function decodeGetCdnTokenEx(body: Buffer): string | null {
  if (body.length < 5) return null;
  const data = body.subarray(4);
  const packet = new TarsInputStream(data);
  const payload = packet.readBytes(7); // sBuffer
  if (!payload) return null;

  const mapStream = new TarsInputStream(payload);
  const entries = mapStream.readMapStrBytes(0);
  if (!entries) return null;
  const tRsp = entries.get('tRsp');
  if (!tRsp) return null;

  // HUYA.GetCdnTokenExRsp 结构体在 tag 0, sFlvToken 在结构体内 tag 0
  const rspStream = new TarsInputStream(tRsp);
  return rspStream.readStruct(0, (stream) => stream.readString(0));
}
