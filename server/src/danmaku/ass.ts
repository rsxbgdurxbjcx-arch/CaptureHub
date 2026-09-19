/**
 * 弹幕 XML (B 站兼容格式) → ASS 字幕
 * 供弹幕烧录使用: 全滚动弹幕、统一速度(互不追尾)、轨道自上而下分配。
 *
 * 输入 XML 结构: <d p="相对秒,mode,size,color,时间戳,0,uid,0">内容</d>
 * (由 danmaku/xml-writer.ts 生成; mode 恒为 1, 即滚动弹幕)
 */
import fs from 'node:fs';

export interface DanmakuItem {
  /** 相对视频起点的秒数 */
  time: number;
  /** 十进制 RGB (B 站格式, 16777215 = 白色) */
  color: number;
  text: string;
}

/** XML 实体反转义 (&amp; 最后处理, 避免二次解码) */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** 解析弹幕 XML, 返回按时间升序的弹幕列表 (文件缺失/无弹幕时返回空数组) */
export function parseDanmakuXml(xmlPath: string): DanmakuItem[] {
  let raw = '';
  try {
    raw = fs.readFileSync(xmlPath, 'utf8');
  } catch {
    return [];
  }
  const items: DanmakuItem[] = [];
  const re = /<d p="([^"]*)"[^>]*>([^<]*)<\/d>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const fields = m[1].split(',');
    const time = Number.parseFloat(fields[0] ?? '');
    if (!Number.isFinite(time) || time < 0) continue;
    const text = unescapeXml(m[2]);
    if (!text.trim()) continue;
    const color = Number.parseInt(fields[3] ?? '', 10);
    items.push({
      time,
      color: Number.isFinite(color) ? color : 0xffffff,
      text,
    });
  }
  items.sort((a, b) => a.time - b.time);
  return items;
}

/** ASS 文本转义: 反斜杠/花括号替换为全角, 避免被 libass 当作控制符解析 */
function escapeAssText(s: string): string {
  return s
    .replace(/\\/g, '＼')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\r?\n/g, ' ');
}

/** 十进制 RGB → ASS 颜色 (&H00BBGGRR 字节序) */
function assColor(rgb: number): string {
  const r = ((rgb >> 16) & 0xff).toString(16).padStart(2, '0');
  const g = ((rgb >> 8) & 0xff).toString(16).padStart(2, '0');
  const b = (rgb & 0xff).toString(16).padStart(2, '0');
  return `&H00${b}${g}${r}`.toUpperCase();
}

/** 秒 → ASS 时间 (H:MM:SS.cc, 厘秒精度) */
function formatAssTime(sec: number): string {
  const centis = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(centis / 360_000);
  const m = Math.floor((centis % 360_000) / 6000);
  const s = Math.floor((centis % 6000) / 100);
  const cs = centis % 100;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

/** 文本像素宽估算 (CJK/全角按 1 字宽, 其余按 0.55 字宽) */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp > 0x2e80 ? fontSize : fontSize * 0.55;
  }
  return Math.ceil(w);
}

/**
 * 弹幕字号 — 基准 66px (经用户对比 B 站直播间录屏选定, 与虎牙烧录效果一致)。
 * B 站: 固定 66px(与虎牙烧录完全一致, 用户要求参考虎牙对齐)。
 * 其他平台(虎牙/斗鱼等): 1080p 及以上固定 66px; 低于 1080p 时等比缩小,
 * 保持与 1080p 相同的视觉占比。
 */
const FONT_SIZE_BASE = 66;
function danmakuFontSize(height: number, platform?: string): number {
  if (platform === 'bilibili') return FONT_SIZE_BASE;
  if (height >= 1080) return FONT_SIZE_BASE;
  return Math.max(16, Math.round((FONT_SIZE_BASE * height) / 1080));
}

export interface BuildAssOptions {
  width: number;
  height: number;
  /** 平台标识: B 站固定 66px 与虎牙一致; 其他平台低分辨率等比缩小 */
  platform?: string;
  /** ASS 样式字体名 (须为渲染环境已安装字体) */
  fontName?: string;
}

/**
 * 生成 ASS 字幕。
 * 滚动采用统一速度: 同速下"后一条开始时间 ≥ 前一条开始时间 + 前一条宽度/速度"
 * 即永不追上, 轨道分配据此判定。
 * 字号(B 站固定 66px 与虎牙一致; 其他平台 1080p 基准 66px、低分辨率等比)/速度(256px/s)/区域(顶部半屏)/描边(2px)/粗体 均按 B 站直播间录屏对齐。
 */
export function buildDanmakuAss(items: DanmakuItem[], opts: BuildAssOptions): string {
  const W = Math.max(320, Math.round(opts.width));
  const H = Math.max(240, Math.round(opts.height));
  const fontName = opts.fontName ?? 'Noto Sans CJK SC';
  const fontSize = danmakuFontSize(H, opts.platform);
  const lineHeight = Math.max(8, Math.round(fontSize * 1.4));
  const topMargin = Math.round(H * 0.01);
  // 弹幕区域: 顶部半屏(对齐 B 站直播间"半屏"区域)
  const trackCount = Math.max(1, Math.floor((H * 0.5 - topMargin) / lineHeight));
  // 滚动速度: B 站直播引擎固定值 speed = 1920/4.5*0.6 = 256 px/s(绝对, 不随画布缩放)
  const speed = 256;
  const TRACK_GAP_SEC = 0.1;

  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Danmaku,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  // 每轨道记录上一条弹幕的开始时间与估算宽度
  const lastStart = new Array<number>(trackCount).fill(Number.NEGATIVE_INFINITY);
  const lastWidth = new Array<number>(trackCount).fill(0);

  for (const item of items) {
    const widthPx = estimateTextWidth(item.text, fontSize);
    const duration = (W + widthPx) / speed;
    let track = -1;
    for (let i = 0; i < trackCount; i++) {
      const readyAt = lastStart[i] + lastWidth[i] / speed + TRACK_GAP_SEC;
      if (item.time >= readyAt) {
        track = i;
        break;
      }
    }
    // 无可用轨道: 丢弃该弹幕(对齐 B 站直播间行为 — 高密度时新弹幕不上屏, 避免重叠造成"眼花")
    if (track < 0) continue;
    lastStart[track] = item.time;
    lastWidth[track] = widthPx;

    const y = topMargin + track * lineHeight;
    const start = item.time;
    const end = item.time + duration;
    // 过暗颜色在黑色描边下不可读, 回退白色(B 站同款处理思路)
    const rgb = item.color & 0xffffff;
    const brightness = ((rgb >> 16) & 0xff) + ((rgb >> 8) & 0xff) + (rgb & 0xff);
    const colorTag = rgb !== 0xffffff && brightness >= 0x80 ? `\\c${assColor(rgb)}` : '';
    lines.push(
      `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Danmaku,,0,0,0,,{\\move(${W},${y},${-widthPx},${y})${colorTag}}${escapeAssText(item.text)}`,
    );
  }

  return lines.join('\n') + '\n';
}
