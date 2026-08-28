export type StreamerStatus =
  | 'offline'
  | 'online'
  | 'recording'
  | 'parse_error'
  | 'unknown';

export type DownloaderType = 'ffmpeg';
export type RcloneMode = 'move' | 'copy';
export type UploadTool = 'grammy' | 'rclone';
export type GrammyMode = 'move' | 'copy';
export type Platform = 'xhs' | 'douyin' | 'bilibili' | 'kuaishou' | 'soop' | 'pandalive' | 'stripchat';
export type RecordQuality = 'OD' | 'UHD' | 'HD' | 'SD' | 'LD';

export interface Streamer {
  id: string;
  name: string;
  profileUrl: string;
  platform: Platform;
  roomId: string | null;
  userId: string | null;
  redId: string | null;
  avatar: string | null;
  /** 头像最近一次成功更新时间(每日刷新一次用) */
  avatarUpdatedAt?: string | null;
  title: string | null;
  status: StreamerStatus;
  enabled: boolean;
  downloader: DownloaderType | 'global';
  recordQuality: RecordQuality | null;
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
  /** grammY 上传配置（替代原 tdl） */
  grammyBotToken: string;
  grammyChatId: string;
  grammyApiId: string;
  grammyApiHash: string;
  grammyLocalPort: number;
  grammyMode: GrammyMode;
  /** telegram-bot-api 二进制路径（内置 Local Server） */
  telegramBotApiPath: string;
  ffmpegPath: string;
  rclonePath: string;
  maxConcurrentRecordings: number;
  maxConcurrentUploads: number;
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
  trigger: string;
  fileId: string;
  streamerName: string;
  filename: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  log: string;
  createdAt: string;
  finishedAt: string | null;
  /** 上传工具与模式(如 grammy/move、rclone/copy) */
  uploadTool: string | null;
  uploadMode: string | null;
}

export interface PostProcessConfig {
  uploadTool: UploadTool;
  postProcessScript: string;
  postProcessOnStreamEnd: boolean;
  postProcessOnManualStop: boolean;
  postProcessOnSegment: boolean;
  rcloneRemote: string;
  rcloneRemotePath: string;
  rcloneMode: RcloneMode;
  rcloneDeleteLocalOnMove: boolean;
  maxConcurrentUploads: number;
  /** grammY 配置（替代原 tdl） */
  grammyBotToken: string;
  grammyChatId: string;
  grammyApiId: string;
  grammyApiHash: string;
  grammyLocalPort: number;
  grammyMode: GrammyMode;
  telegramBotApiPath: string;
}

/** Local Bot API Server 状态 */
export interface BotServerStatus {
  status: 'stopped' | 'starting' | 'running' | 'error';
  pid: number | null;
  port: number | null;
  apiRoot: string | null;
  startedAt: number | null;
  lastError: string | null;
  restartCount: number;
}

/** Stripchat Mouflon 密钥同步状态(对应 StripchatRecorder MouflonKeysStore 状态) */
export interface MouflonSyncStatus {
  /** 同步 Worker URL */
  url: string;
  /** 同步 Worker 鉴权 Token */
  token: string;
  /** 当前可用密钥总数(手动 + Worker 同步) */
  keyCount: number;
  /** 最近一次 Worker 同步的密钥更新时间(从未同步为 null) */
  autoSyncedAt: string | null;
  /** 最近一次手动修改密钥时间(从未修改为 null) */
  manualUpdatedAt: string | null;
  /** 最近一次同步触发时间 */
  lastSyncAt: string | null;
  /** 最近一次同步错误(无错误为 null) */
  lastSyncError: string | null;
}
