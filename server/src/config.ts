import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from './types.js';

// 环境变量:优先使用 CAPTUREHUB_* 命名,兼容旧版 RED_* 命名
const envOr = (name: string, legacy: string) =>
  process.env[name] || process.env[legacy];

const ROOT = envOr('CAPTUREHUB_ROOT', 'RED_ROOT') || path.resolve(process.cwd(), '..');
const DATA_DIR =
  envOr('CAPTUREHUB_DATA_DIR', 'RED_DATA_DIR') || path.join(ROOT, 'data');
const RECORDINGS_DIR =
  envOr('CAPTUREHUB_RECORDINGS_DIR', 'RED_RECORDINGS_DIR') ||
  path.join(ROOT, 'recordings');
const LOGS_DIR =
  envOr('CAPTUREHUB_LOGS_DIR', 'RED_LOGS_DIR') || path.join(ROOT, 'logs');

export const PATHS = {
  root: ROOT,
  data: DATA_DIR,
  recordings: RECORDINGS_DIR,
  logs: LOGS_DIR,
  db: path.join(DATA_DIR, 'capturehub.db'),
  settings: path.join(DATA_DIR, 'settings.json'),
  clientDist:
    envOr('CAPTUREHUB_CLIENT_DIST', 'RED_CLIENT_DIST') ||
    path.join(ROOT, 'client', 'dist'),
};

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSec: 5,
  segmentDuration: '',
  segmentFileSize: '',
  downloader: 'ffmpeg',
  autoTranscode: true,
  cookie: '',
  cookieXhs: '',
  cookieDouyin: '',
  cookieBilibili: '',
  cookieKuaishou: '',
  cookieSoop: '',
  cookiePandalive: '',
  cookieStripchat: '',
  soopUsername: '',
  soopPassword: '',
  stripchatMouflonKeys: '',
  stripchatMouflonSyncUrl: 'https://mouflon.chantrail.com',
  stripchatMouflonSyncToken: '',
  recordQuality: 'OD',
  recordingsDir: RECORDINGS_DIR,
  uploadTool: 'rclone',
  rcloneRemote: 'pikpak',
  rcloneRemotePath: 'capturehub',
  rcloneMode: 'move',
  rcloneDeleteLocalOnMove: true,
  postProcessScript: `#!/bin/sh
# CaptureHub 默认后处理脚本:使用 rclone 上传到网盘
# 环境变量:
#   CAPTUREHUB_FILE_PATH     本地视频绝对路径
#   CAPTUREHUB_FILE_NAME     文件名
#   CAPTUREHUB_STREAMER      主播名
#   CAPTUREHUB_REMOTE        rclone remote 名 (默认 pikpak)
#   CAPTUREHUB_REMOTE_ROOT   网盘根目录 (默认 capturehub)
#   CAPTUREHUB_TRIGGER       stream_end | manual_stop | segment | manual
#   CAPTUREHUB_RCLONE        rclone 可执行文件 (默认 rclone)
#   CAPTUREHUB_RCLONE_MODE   move | copy  (默认 move)
#   CAPTUREHUB_DELETE_LOCAL  1 | 0  (仅在 move 模式下生效)
#   RCLONE_CONFIG     rclone 配置文件路径

set -e

RCLONE="\${CAPTUREHUB_RCLONE:-rclone}"
CONFIG="\${RCLONE_CONFIG:-/config/rclone/rclone.conf}"
REMOTE="\${CAPTUREHUB_REMOTE:-pikpak}"
ROOT="\${CAPTUREHUB_REMOTE_ROOT:-capturehub}"
STREAMER="\${CAPTUREHUB_STREAMER:-unknown}"
FILE="\${CAPTUREHUB_FILE_PATH}"
NAME="\${CAPTUREHUB_FILE_NAME}"
MODE="\${CAPTUREHUB_RCLONE_MODE:-move}"
DEL="\${CAPTUREHUB_DELETE_LOCAL:-1}"

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "文件不存在: $FILE"
  exit 1
fi

# --- rclone 配置文件查找(带重试,最多等待 30 秒) ---
# entrypoint 后台守护进程每 10 秒修复一次 rclone.conf 权限,
# 此处重试机制确保即使用户刚复制配置文件也能等到权限修复完成
CONFIG_FOUND=""
RETRY=0
MAX_RETRY=15
while [ $RETRY -lt $MAX_RETRY ]; do
  for TRY_CONFIG in "$CONFIG" "/home/node/.config/rclone/rclone.conf" "$HOME/.config/rclone/rclone.conf"; do
    if [ -f "$TRY_CONFIG" ] && [ -r "$TRY_CONFIG" ]; then
      CONFIG_FOUND="$TRY_CONFIG"
      break 2
    fi
  done
  if [ -z "$CONFIG_FOUND" ]; then
    if [ $RETRY -eq 0 ]; then
      echo "等待 rclone 配置文件就绪..."
    fi
    sleep 2
    RETRY=$((RETRY + 1))
  fi
done

if [ -z "$CONFIG_FOUND" ]; then
  echo "错误: 无法读取 rclone 配置文件 (已等待 30 秒)"
  echo "  尝试过的位置: $CONFIG, /home/node/.config/rclone/rclone.conf"
  echo "  请检查文件权限: chmod 644 $CONFIG"
  echo "  或在容器内执行: docker exec capturehub chmod 644 $CONFIG"
  exit 1
fi

CONFIG="$CONFIG_FOUND"
DEST="\${REMOTE}:\${ROOT}/\${STREAMER}"
echo "rclone: $RCLONE"
echo "config: $CONFIG"
echo "trigger: \${CAPTUREHUB_TRIGGER:-unknown}"
echo "模式: $MODE  上传 $FILE -> $DEST/"

# 确保网盘目标目录存在
"$RCLONE" mkdir "$DEST" --config "$CONFIG" 2>/dev/null || true

if [ "$MODE" = "move" ]; then
  # rclone move: 边传边删;失败时本地副本仍存在
  # --progress --stats-one-line --stats=1s: 每秒输出一行进度(供前端解析展示上传速度/百分比)
  "$RCLONE" move "$FILE" "$DEST/" --config "$CONFIG" --transfers 2 --checkers 4 --progress --stats-one-line --stats=1s
else
  "$RCLONE" copy "$FILE" "$DEST/" --config "$CONFIG" --transfers 2 --checkers 4 --progress --stats-one-line --stats=1s
fi

echo "上传完成: $DEST/$NAME"
`,
  postProcessOnStreamEnd: true,
  postProcessOnManualStop: true,
  postProcessOnSegment: true,
  grammyBotToken: '',
  grammyChatId: '',
  grammyApiId: '',
  grammyApiHash: '',
  grammyLocalPort: 8081,
  grammyMode: 'move',
  telegramBotApiPath: process.env.TELEGRAM_BOT_API_PATH || 'telegram-bot-api',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  rclonePath: process.env.RCLONE_PATH || 'rclone',
  maxConcurrentRecordings: -1,
  maxConcurrentUploads: 3,
  grammyMaxConcurrentUploads: 1,
};

export function ensureDirs() {
  for (const dir of [PATHS.data, PATHS.recordings, PATHS.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadSettings(): Settings {
  ensureDirs();
  if (!fs.existsSync(PATHS.settings)) {
    saveSettings(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = fs.readFileSync(PATHS.settings, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed, recordingsDir: RECORDINGS_DIR };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings) {
  ensureDirs();
  const toSave = { ...settings, recordingsDir: RECORDINGS_DIR };
  fs.writeFileSync(PATHS.settings, JSON.stringify(toSave, null, 2), 'utf8');
}

export const PORT = Number(process.env.PORT || 3780);
export const HOST = process.env.HOST || '0.0.0.0';
