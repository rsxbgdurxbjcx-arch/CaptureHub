export type StreamerStatus =
  | 'offline'
  | 'online'
  | 'recording'
  | 'parse_error'
  | 'unknown';

export type Platform = 'xhs' | 'douyin' | 'bilibili' | 'kuaishou' | 'soop' | 'pandalive' | 'stripchat';

export type DownloaderType = 'ffmpeg';

export type RecordQuality = 'OD' | 'UHD' | 'HD' | 'SD' | 'LD';

export type RcloneMode = 'move' | 'copy';

export type UploadTool = 'grammy' | 'rclone';

export type GrammyMode = 'move' | 'copy';

export type PostProcessTrigger =
  | 'stream_end'
  | 'manual_stop'
  | 'segment'
  | 'manual';

export interface Streamer {
  id: string;
  name: string;
  profileUrl: string;
  platform: Platform;
  roomId: string | null;
  userId: string | null;
  redId: string | null;
  avatar: string | null;
  /** 头像最近一次成功更新时间(每日刷新一次用,空表示从未成功获取) */
  avatarUpdatedAt: string | null;
  title: string | null;
  status: StreamerStatus;
  enabled: boolean;
  downloader: DownloaderType | 'global';
  recordQuality: RecordQuality;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastLiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordingFile {
  id: string;
  streamerId: string | null;
  streamerName: string;
  filename: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  durationSec: number | null;
  format: string;
  status: 'recording' | 'ready' | 'processing' | 'uploaded' | 'error';
  uploadTool: string | null;
  uploadMode: string | null;
  createdAt: string;
  updatedAt: string;
  uploadedAt: string | null;
  remotePath: string | null;
  error: string | null;
}

export interface Settings {
  pollIntervalSec: number;
  segmentDuration: string;
  segmentFileSize: string;
  downloader: DownloaderType;
  autoTranscode: boolean;
  cookie: string;
  cookieXhs: string;
  cookieDouyin: string;
  cookieBilibili: string;
  cookieKuaishou: string;
  cookieSoop: string;
  cookiePandalive: string;
  cookieStripchat: string;
  soopUsername: string;
  soopPassword: string;
  /** Stripchat Mouflon 解密密钥 (pkey=pdkey 多行文本) */
  stripchatMouflonKeys: string;
  /** Stripchat Mouflon 密钥同步 Worker URL (为空则不自动同步) */
  stripchatMouflonSyncUrl: string;
  /** Stripchat Mouflon 密钥同步 Worker 鉴权 Token (可选) */
  stripchatMouflonSyncToken: string;
  recordQuality: RecordQuality;
  recordingsDir: string;
  uploadTool: UploadTool;
  rcloneRemote: string;
  rcloneRemotePath: string;
  rcloneMode: RcloneMode;
  rcloneDeleteLocalOnMove: boolean;
  postProcessScript: string;
  postProcessOnStreamEnd: boolean;
  postProcessOnManualStop: boolean;
  postProcessOnSegment: boolean;
  /** grammY 上传配置(替代原 tdl) */
  grammyBotToken: string;
  grammyChatId: string;
  grammyApiId: string;
  grammyApiHash: string;
  grammyLocalPort: number;
  grammyMode: GrammyMode;
  /** telegram-bot-api 二进制路径(内置 Local Server) */
  telegramBotApiPath: string;
  ffmpegPath: string;
  rclonePath: string;
  maxConcurrentRecordings: number;
  maxConcurrentUploads: number;
  /** grammY 专属最大并发上传数(独立于 rclone) */
  grammyMaxConcurrentUploads: number;
}

export interface LiveInfo {
  living: boolean;
  roomId: string;
  title: string;
  owner: string;
  avatar: string;
  cover: string;
  flvUrl?: string;
  m3u8Url?: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface SystemStatus {
  uptimeSec: number;
  recordingCount: number;
  streamerCount: number;
  onlineCount: number;
  diskRecordingsBytes: number;
  tools: {
    ffmpeg: boolean;
    rclone: boolean;
    telegramBotApi: boolean;
  };
  version: string;
}

export interface PostProcessJob {
  id: string;
  trigger: PostProcessTrigger;
  fileId: string;
  streamerName: string;
  filename: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  log: string;
  createdAt: string;
  finishedAt: string | null;
  /** 上传工具与模式(如 grammy/move、rclone/copy),用于前端日志卡片展示 */
  uploadTool: string | null;
  uploadMode: string | null;
}
