import type {
  ApiResponse,
  RecordingFile,
  Settings,
  Streamer,
  SystemStatus,
  PostProcessJob,
  PostProcessConfig,
  Platform,
  RecordQuality,
  BotServerStatus,
  MouflonSyncStatus,
} from './types';

const TOKEN_KEY = 'capturehub_auth_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    throw new Error(`网络错误: ${(e as Error).message}`);
  }

  // 401 → 清除 token，跳转登录
  if (res.status === 401) {
    clearToken();
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    let msg = '登录已过期';
    try {
      const body = (await res.clone().json()) as ApiResponse;
      if (body?.error) msg = body.error;
      else if (body?.message) msg = body.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  let data: ApiResponse<T>;
  try {
    data = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new Error(`服务器响应无效 (HTTP ${res.status})`);
  }

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }
  return data.data as T;
}

export const api = {
  // -- 认证 --
  login: (username: string, password: string) =>
    request<{ token: string; username: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<unknown>('/api/auth/logout', { method: 'POST' }),
  authStatus: () => request<{ authenticated: boolean; username: string | null }>('/api/auth/status'),
  changeCredentials: (body: { username: string; currentPassword: string; newPassword?: string }) =>
    request<{ token: string; username: string }>('/api/auth/change-credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // -- 系统 --
  status: () => request<SystemStatus>('/api/system/status'),
  restartMonitor: () => request<unknown>('/api/system/monitor/restart', { method: 'POST' }),

  // -- 主播 --
  listStreamers: () => request<Streamer[]>('/api/streamers'),
  getStreamer: (id: string) => request<Streamer>(`/api/streamers/${id}`),
  createStreamer: (body: {
    profileUrl: string;
    name?: string;
    platform?: Platform;
    enabled?: boolean;
    downloader?: string;
    redId?: string | null;
    roomId?: string | null;
    recordQuality?: RecordQuality;
  }) => request<Streamer>('/api/streamers', { method: 'POST', body: JSON.stringify(body) }),
  updateStreamer: (id: string, body: Record<string, unknown>) =>
    request<Streamer>(`/api/streamers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteStreamer: (id: string) => request<unknown>(`/api/streamers/${id}`, { method: 'DELETE' }),
  batchDeleteStreamers: (ids: string[]) =>
    request<Streamer[]>('/api/streamers/batch/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  checkStreamer: (id: string) => request<Streamer>(`/api/streamers/${id}/check`, { method: 'POST' }),
  stopStreamer: (id: string) => request<{ stopped: boolean }>(`/api/streamers/${id}/stop`, { method: 'POST' }),
  startStreamer: (id: string) => request<Streamer>(`/api/streamers/${id}/start`, { method: 'POST' }),

  // -- 文件 --
  listFiles: () => request<RecordingFile[]>('/api/files'),
  deleteFile: (id: string) => request<unknown>(`/api/files/${id}`, { method: 'DELETE' }),
  batchDeleteFiles: (ids: string[]) =>
    request<RecordingFile[]>('/api/files/batch/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  /** move 模式上传完成后记录会被删除,返回 null */
  uploadFile: (id: string) => request<RecordingFile | null>(`/api/files/${id}/upload`, { method: 'POST' }),
  getUploadProgress: () =>
    request<Record<string, {
      fileId: string;
      progress: number;
      speed: number;
      uploadedBytes: number;
      totalBytes: number;
      phase: string;
      startedAt: number;
    }>>('/api/files/progress'),
  /** 实时获取录制中文件的真实大小 { fileId: bytes } */
  getRecordingFileSizes: () => request<Record<string, number>>('/api/files/sizes'),
  syncFiles: () => request<RecordingFile[]>('/api/files/sync', { method: 'POST' }),
  deleteUploadedFiles: () => request<RecordingFile[]>('/api/files/uploaded/batch', { method: 'DELETE' }),

  // -- 后处理 --
  getPostConfig: () => request<PostProcessConfig>('/api/postprocess/config'),
  savePostConfig: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/postprocess/config', { method: 'PUT', body: JSON.stringify(body) }),
  listJobs: () => request<PostProcessJob[]>('/api/postprocess/jobs'),
  clearJobs: () => request<unknown>('/api/postprocess/jobs', { method: 'DELETE' }),
  runPost: (fileId: string) => request<unknown>(`/api/postprocess/run/${fileId}`, { method: 'POST' }),

  // -- Local Bot API Server 管理 --
  getBotServerStatus: () => request<BotServerStatus>('/api/postprocess/bot-server/status'),
  startBotServer: () => request<BotServerStatus>('/api/postprocess/bot-server/start', { method: 'POST' }),
  stopBotServer: () => request<BotServerStatus>('/api/postprocess/bot-server/stop', { method: 'POST' }),

  // -- 设置 --
  getSettings: () => request<Settings>('/api/settings'),
  saveSettings: (body: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  resetSettings: () => request<Settings>('/api/settings/reset', { method: 'POST' }),

  // -- Stripchat Mouflon 密钥同步状态 --
  getMouflonSyncStatus: () =>
    request<MouflonSyncStatus>('/api/settings/stripchat/mouflon/status'),
  syncMouflonKeys: () =>
    request<{ updated: boolean }>('/api/settings/stripchat/mouflon/sync', { method: 'POST' }),
};

export function mediaUrl(relativePath: string) {
  const base = `/media/${String(relativePath).split('/').map(encodeURIComponent).join('/')}`;
  // 媒体路由已要求鉴权:<video> 无法携带 header,统一附带 ?token=
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/** 构建主播直播画面快照 URL（带 token 认证，用于 <img> 标签） */
export function snapshotUrl(streamerId: string, t: number): string {
  const token = getToken();
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
  return `/api/streamers/${streamerId}/snapshot?t=${t}${tokenParam}`;
}
