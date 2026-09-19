/**
 * 弹幕烧录: 把同名 XML 弹幕渲染进视频画面, 输出带弹幕的 mp4。
 * 由 postprocess 在上传前调用; 渲染依赖容器内已安装 CJK 字体 (Dockerfile: font-noto-cjk)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDanmakuAss, parseDanmakuXml } from './ass.js';
import { runCommand } from '../utils.js';

export interface RenderDanmakuOptions {
  videoPath: string;
  xmlPath: string;
  /** 输出路径 (由调用方负责后续原子替换/清理) */
  outPath: string;
  ffmpegPath: string;
  /** 平台标识: B 站固定 66px 与虎牙烧录一致; 其他平台低分辨率等比缩放 */
  platform?: string;
  append: (line: string) => void;
}

/** 从 ffmpeg 路径推导同目录 ffprobe (无目录前缀时按 PATH 查找) */
function resolveFfprobePath(ffmpegPath: string): string {
  const name = path.basename(ffmpegPath).replace(/ffmpeg/i, 'ffprobe');
  return ffmpegPath.includes('/') || ffmpegPath.includes('\\')
    ? path.join(path.dirname(ffmpegPath), name)
    : name;
}

/** ffprobe 读取视频宽高 (失败或异常时回退 1920x1080) */
function probeVideoSize(
  videoPath: string,
  ffmpegPath: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const { done } = runCommand(
        resolveFfprobePath(ffmpegPath),
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0',
          videoPath,
        ],
        { onStdout: (l) => (out += l) },
      );
      void done.then(() => {
        const m = /(\d+)\s*,\s*(\d+)/.exec(out);
        resolve(
          m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1920, height: 1080 },
        );
      });
    } catch {
      resolve({ width: 1920, height: 1080 });
    }
  });
}

/**
 * 渲染弹幕进视频 (libx264 重编码烧录, 音频优先 copy、失败回退 aac)。
 * 成功返回 true; 无弹幕/烧录失败返回 false (由调用方回退普通流程)。
 */
export async function renderDanmakuVideo(opts: RenderDanmakuOptions): Promise<boolean> {
  const { videoPath, xmlPath, outPath, ffmpegPath, append } = opts;

  const items = parseDanmakuXml(xmlPath);
  if (items.length === 0) {
    append('[danmaku] 弹幕文件为空, 跳过烧录');
    return false;
  }
  append(`[danmaku] 读取弹幕 ${items.length} 条, 开始生成 ASS`);

  const { width, height } = await probeVideoSize(videoPath, ffmpegPath);
  const assText = buildDanmakuAss(items, { width, height, platform: opts.platform });
  // ASS 落到系统临时目录: 纯 ASCII 路径, 规避 ffmpeg 滤镜参数对中文/空格的转义问题
  const assPath = path.join(
    os.tmpdir(),
    `danmaku-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ass`,
  );
  fs.writeFileSync(assPath, assText, 'utf8');

  const burn = (audioArgs: string[]) => {
    const args = [
      '-y',
      '-nostats',
      // libass 对弹幕中 emoji/罕见字形缺失的提示为 info 级, 默认会逐字形刷屏
      // (单条视频可达数万行); 仅保留 warning 及以上, 真正的错误仍会输出
      '-loglevel',
      'warning',
      '-i',
      videoPath,
      '-vf',
      `ass=${assPath}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      ...audioArgs,
      '-f',
      'mp4',
      '-movflags',
      '+faststart',
      outPath,
    ];
    append(`[danmaku] ffmpeg ${args.join(' ')}`);
    const { done } = runCommand(ffmpegPath, args, {
      onStderr: (l) => append(`[ffmpeg] ${l}`),
    });
    return done;
  };

  try {
    let r = await burn(['-c:a', 'copy']);
    let ok = r.code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024;
    if (!ok) {
      append('[danmaku] 音频 -c:a copy 失败, 回退 -c:a aac');
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch { /* ignore */ }
      r = await burn(['-c:a', 'aac', '-b:a', '192k']);
      ok = r.code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024;
    }
    if (!ok) {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch { /* ignore */ }
      append('[danmaku] 烧录失败, 回退普通流程');
      return false;
    }
    const size = fs.statSync(outPath).size;
    append(`[danmaku] 烧录完成, 输出 ${(size / 1024 / 1024).toFixed(1)} MB`);
    return true;
  } finally {
    try {
      fs.unlinkSync(assPath);
    } catch { /* ignore */ }
  }
}
