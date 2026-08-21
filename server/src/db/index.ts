import Database from 'better-sqlite3';
import fs from 'node:fs';
import { PATHS, ensureDirs } from '../config.js';
import type {
  Streamer,
  RecordingFile,
  PostProcessJob,
  StreamerStatus,
  DownloaderType,
  Platform,
  RecordQuality,
} from '../types.js';

let db: Database.Database;

export function getDb() {
  if (!db) {
    ensureDirs();
    // 迁移旧版本数据库文件名: red.db → capturehub.db(项目更名)
    const legacyDb = pathJoin(PATHS.data, 'red.db');
    if (!fs.existsSync(PATHS.db) && fs.existsSync(legacyDb)) {
      try {
        fs.renameSync(legacyDb, PATHS.db);
        // WAL 模式可能残留旧 -wal/-shm 文件,一并迁移
        for (const suffix of ['-wal', '-shm']) {
          const from = `${legacyDb}${suffix}`;
          if (fs.existsSync(from)) {
            fs.renameSync(from, `${PATHS.db}${suffix}`);
          }
        }
      } catch {
        // 迁移失败时回退使用旧文件名,避免数据丢失
        db = new Database(legacyDb);
      }
    }
    if (!db) {
      db = new Database(PATHS.db);
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate();
  }
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS streamers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      profile_url TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'xhs',
      room_id TEXT,
      user_id TEXT,
      red_id TEXT,
      avatar TEXT,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      downloader TEXT NOT NULL DEFAULT 'global',
      record_quality TEXT NOT NULL DEFAULT 'OD',
      last_error TEXT,
      last_checked_at TEXT,
      last_live_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      streamer_id TEXT,
      streamer_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      absolute_path TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      duration_sec REAL,
      format TEXT NOT NULL DEFAULT 'mp4',
      status TEXT NOT NULL DEFAULT 'ready',
      upload_tool TEXT,
      upload_mode TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      uploaded_at TEXT,
      remote_path TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS postprocess_jobs (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      file_id TEXT NOT NULL,
      streamer_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      log TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_streamers_enabled ON streamers(enabled);
  `);

  // Migration: add platform column for existing databases
  try {
    const cols = getDb().prepare('PRAGMA table_info(streamers)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'platform')) {
      getDb().exec("ALTER TABLE streamers ADD COLUMN platform TEXT NOT NULL DEFAULT 'xhs'");
    }
  } catch {
    // ignore migration errors
  }

  // Migration: add record_quality column for existing databases
  try {
    const cols = getDb().prepare('PRAGMA table_info(streamers)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'record_quality')) {
      getDb().exec("ALTER TABLE streamers ADD COLUMN record_quality TEXT NOT NULL DEFAULT 'OD'");
    }
  } catch {
    // ignore migration errors
  }

  // Migration: add avatar_updated_at column for existing databases
  // (用于头像每日刷新一次;空表示从未成功获取头像)
  try {
    const cols = getDb().prepare('PRAGMA table_info(streamers)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'avatar_updated_at')) {
      getDb().exec('ALTER TABLE streamers ADD COLUMN avatar_updated_at TEXT');
    }
  } catch {
    // ignore migration errors
  }

  // Migration: add upload_tool and upload_mode columns for existing databases
  try {
    const fileCols = getDb().prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    if (!fileCols.some((c) => c.name === 'upload_tool')) {
      getDb().exec('ALTER TABLE files ADD COLUMN upload_tool TEXT');
    }
    if (!fileCols.some((c) => c.name === 'upload_mode')) {
      getDb().exec('ALTER TABLE files ADD COLUMN upload_mode TEXT');
    }
  } catch {
    // ignore migration errors
  }

  // Migration: add upload_tool and upload_mode columns to postprocess_jobs
  try {
    const jobCols = getDb().prepare('PRAGMA table_info(postprocess_jobs)').all() as Array<{ name: string }>;
    if (!jobCols.some((c) => c.name === 'upload_tool')) {
      getDb().exec('ALTER TABLE postprocess_jobs ADD COLUMN upload_tool TEXT');
    }
    if (!jobCols.some((c) => c.name === 'upload_mode')) {
      getDb().exec('ALTER TABLE postprocess_jobs ADD COLUMN upload_mode TEXT');
    }
  } catch {
    // ignore migration errors
  }
}

function rowToStreamer(row: any): Streamer {
  return {
    id: row.id,
    name: row.name,
    profileUrl: row.profile_url,
    platform: (row.platform || 'xhs') as Platform,
    roomId: row.room_id,
    userId: row.user_id,
    redId: row.red_id,
    avatar: row.avatar,
    avatarUpdatedAt: row.avatar_updated_at || null,
    title: row.title,
    status: row.status as StreamerStatus,
    enabled: !!row.enabled,
    downloader: row.downloader as DownloaderType | 'global',
    recordQuality: (row.record_quality || 'OD') as RecordQuality,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at,
    lastLiveAt: row.last_live_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFile(row: any): RecordingFile {
  return {
    id: row.id,
    streamerId: row.streamer_id,
    streamerName: row.streamer_name,
    filename: row.filename,
    relativePath: row.relative_path,
    absolutePath: row.absolute_path,
    size: row.size,
    durationSec: row.duration_sec,
    format: row.format,
    status: row.status,
    uploadTool: row.upload_tool || null,
    uploadMode: row.upload_mode || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    uploadedAt: row.uploaded_at,
    remotePath: row.remote_path,
    error: row.error,
  };
}

function rowToJob(row: any): PostProcessJob {
  return {
    id: row.id,
    trigger: row.trigger,
    fileId: row.file_id,
    streamerName: row.streamer_name,
    filename: row.filename,
    status: row.status,
    log: row.log,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    uploadTool: row.upload_tool || null,
    uploadMode: row.upload_mode || null,
  };
}

export const streamerRepo = {
  list(): Streamer[] {
    const rows = getDb()
      .prepare('SELECT * FROM streamers ORDER BY created_at DESC')
      .all();
    return rows.map(rowToStreamer);
  },
  get(id: string): Streamer | null {
    const row = getDb().prepare('SELECT * FROM streamers WHERE id = ?').get(id);
    return row ? rowToStreamer(row) : null;
  },
  create(s: Streamer) {
    getDb()
      .prepare(
        `INSERT INTO streamers (
          id, name, profile_url, platform, room_id, user_id, red_id, avatar, avatar_updated_at, title,
          status, enabled, downloader, record_quality, last_error, last_checked_at, last_live_at,
          created_at, updated_at
        ) VALUES (
          @id, @name, @profileUrl, @platform, @roomId, @userId, @redId, @avatar, @avatarUpdatedAt, @title,
          @status, @enabled, @downloader, @recordQuality, @lastError, @lastCheckedAt, @lastLiveAt,
          @createdAt, @updatedAt
        )`,
      )
      .run({
        ...s,
        platform: s.platform || 'xhs',
        recordQuality: s.recordQuality || 'OD',
        enabled: s.enabled ? 1 : 0,
      });
  },
  update(id: string, patch: Partial<Streamer>) {
    const cur = streamerRepo.get(id);
    if (!cur) return null;
    const next: Streamer = {
      ...cur,
      ...patch,
      id: cur.id,
      updatedAt: new Date().toISOString(),
    };
    getDb()
      .prepare(
        `UPDATE streamers SET
          name=@name, profile_url=@profileUrl, platform=@platform, room_id=@roomId, user_id=@userId,
          red_id=@redId, avatar=@avatar, avatar_updated_at=@avatarUpdatedAt, title=@title, status=@status,
          enabled=@enabled, downloader=@downloader, record_quality=@recordQuality, last_error=@lastError,
          last_checked_at=@lastCheckedAt, last_live_at=@lastLiveAt,
          updated_at=@updatedAt
        WHERE id=@id`,
      )
      .run({
        ...next,
        platform: next.platform || 'xhs',
        recordQuality: next.recordQuality || 'OD',
        enabled: next.enabled ? 1 : 0,
      });
    return next;
  },
  remove(id: string) {
    getDb().prepare('DELETE FROM streamers WHERE id = ?').run(id);
  },
};

export const fileRepo = {
  list(): RecordingFile[] {
    const rows = getDb()
      .prepare('SELECT * FROM files ORDER BY created_at DESC')
      .all();
    return rows.map(rowToFile);
  },
  get(id: string): RecordingFile | null {
    const row = getDb().prepare('SELECT * FROM files WHERE id = ?').get(id);
    return row ? rowToFile(row) : null;
  },
  getByPath(absolutePath: string): RecordingFile | null {
    const row = getDb()
      .prepare('SELECT * FROM files WHERE absolute_path = ?')
      .get(absolutePath);
    return row ? rowToFile(row) : null;
  },
  create(f: RecordingFile) {
    getDb()
      .prepare(
        `INSERT INTO files (
          id, streamer_id, streamer_name, filename, relative_path, absolute_path,
          size, duration_sec, format, status, upload_tool, upload_mode, created_at, updated_at,
          uploaded_at, remote_path, error
        ) VALUES (
          @id, @streamerId, @streamerName, @filename, @relativePath, @absolutePath,
          @size, @durationSec, @format, @status, @uploadTool, @uploadMode, @createdAt, @updatedAt,
          @uploadedAt, @remotePath, @error
        )`,
      )
      .run(f);
  },
  update(id: string, patch: Partial<RecordingFile>) {
    const cur = fileRepo.get(id);
    if (!cur) return null;
    const next: RecordingFile = {
      ...cur,
      ...patch,
      id: cur.id,
      updatedAt: new Date().toISOString(),
    };
    getDb()
      .prepare(
        `UPDATE files SET
          streamer_id=@streamerId, streamer_name=@streamerName, filename=@filename,
          relative_path=@relativePath, absolute_path=@absolutePath, size=@size,
          duration_sec=@durationSec, format=@format, status=@status,
          upload_tool=@uploadTool, upload_mode=@uploadMode,
          updated_at=@updatedAt, uploaded_at=@uploadedAt, remote_path=@remotePath,
          error=@error
        WHERE id=@id`,
      )
      .run(next);
    return next;
  },
  remove(id: string) {
    getDb().prepare('DELETE FROM files WHERE id = ?').run(id);
  },
  sumSize(): number {
    const row = getDb()
      .prepare('SELECT COALESCE(SUM(size),0) as total FROM files')
      .get() as { total: number };
    return row.total || 0;
  },
};

export const jobRepo = {
  list(limit = 50): PostProcessJob[] {
    const rows = getDb()
      .prepare(
        'SELECT * FROM postprocess_jobs ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit);
    return rows.map(rowToJob);
  },
  get(id: string): PostProcessJob | null {
    const row = getDb()
      .prepare('SELECT * FROM postprocess_jobs WHERE id = ?')
      .get(id);
    return row ? rowToJob(row) : null;
  },
  create(j: PostProcessJob) {
    getDb()
      .prepare(
        `INSERT INTO postprocess_jobs (
          id, trigger, file_id, streamer_name, filename, status, log, created_at, finished_at,
          upload_tool, upload_mode
        ) VALUES (
          @id, @trigger, @fileId, @streamerName, @filename, @status, @log, @createdAt, @finishedAt,
          @uploadTool, @uploadMode
        )`,
      )
      .run(j);
  },
  update(id: string, patch: Partial<PostProcessJob>) {
    const cur = jobRepo.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id };
    getDb()
      .prepare(
        `UPDATE postprocess_jobs SET
          trigger=@trigger, file_id=@fileId, streamer_name=@streamerName,
          filename=@filename, status=@status, log=@log, finished_at=@finishedAt,
          upload_tool=@uploadTool, upload_mode=@uploadMode
        WHERE id=@id`,
      )
      .run(next);
    return next;
  },
};

export function syncFilesFromDisk(recordingsDir: string) {
  if (!fs.existsSync(recordingsDir)) return;
  const walk = (dir: string, base = '') => {
    for (const name of fs.readdirSync(dir)) {
      const abs = pathJoin(dir, name);
      const rel = pathJoin(base, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        // 跳过隐藏目录(如 stripchat 分片录制临时目录 .xxx_segments)
        if (name.startsWith('.')) continue;
        walk(abs, rel);
        continue;
      }
      if (!/\.(mp4|mkv|ts|flv|m4a)$/i.test(name)) continue;
      if (fileRepo.getByPath(abs)) continue;
      const now = new Date().toISOString();
      const streamerName = base.split(/[\\/]/)[0] || 'unknown';
      fileRepo.create({
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        streamerId: null,
        streamerName,
        filename: name,
        relativePath: rel,
        absolutePath: abs,
        size: st.size,
        durationSec: null,
        format: name.split('.').pop()?.toLowerCase() || 'mp4',
        status: 'ready',
        uploadTool: null,
        uploadMode: null,
        createdAt: st.mtime.toISOString(),
        updatedAt: now,
        uploadedAt: null,
        remotePath: null,
        error: null,
      });
    }
  };
  walk(recordingsDir);

  // 清理磁盘上已不存在的文件记录:
  // move 模式上传完成后物理文件已删除,若因转码期间的磁盘同步竞态产生了
  // 残留/重复记录,这里统一清除,保证对应文件卡片自动消失
  // (录制中/处理中的文件一定存在于磁盘,不受影响;空路径的已上传记录有意保留)
  for (const f of fileRepo.list()) {
    if (f.status === 'recording' || f.status === 'processing') continue;
    if (!f.absolutePath) continue;
    if (!fs.existsSync(f.absolutePath)) {
      fileRepo.remove(f.id);
    }
  }
}

function pathJoin(...parts: string[]) {
  return parts.filter(Boolean).join('/').replace(/\\/g, '/');
}
