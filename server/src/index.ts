import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import {
  HOST,
  PORT,
  PATHS,
  ensureDirs,
  loadSettings,
} from './config.js';
import { getDb, syncFilesFromDisk } from './db/index.js';
import { monitorService } from './services/monitor.js';
import { recorderService } from './services/recorder.js';
import { botServerManager } from './services/bot-server-manager.js';
import { syncMouflonKeys } from './stripchat/mouflon.js';

async function main() {
  ensureDirs();
  getDb();
  const settings = loadSettings();
  syncFilesFromDisk(settings.recordingsDir);

  // 启动时清理历史遗留的临时后处理脚本(旧版本失败任务可能残留,一次性清除)
  try {
    const scriptsDir = path.join(PATHS.data, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      for (const name of fs.readdirSync(scriptsDir)) {
        if (name.startsWith('post_')) {
          try { fs.unlinkSync(path.join(scriptsDir, name)); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }

  // 启动时同步 Stripchat Mouflon 解密密钥 (Worker)
  void syncMouflonKeys()
    .then((updated) => {
      if (updated) console.log('[stripchat] 启动时已同步 Mouflon 密钥');
    })
    .catch((e) => {
      console.warn('[stripchat] 启动同步 Mouflon 密钥失败:', e instanceof Error ? e.message : e);
    });

  // 每小时定时同步 Mouflon 密钥
  const mouflonSyncTimer = setInterval(() => {
    void syncMouflonKeys().catch((e) => {
      console.warn('[stripchat] 定时同步 Mouflon 密钥失败:', e instanceof Error ? e.message : e);
    });
  }, 3600 * 1000);

  // 启动恢复：清理进程重启后数据库中残留的 recording 状态
  // 将残留的录制中文件标记为 ready 并触发 rclone 上传
  // (进程崩溃/磁盘满/被强杀时,Stripchat 分片临时目录 .xxx_segments 可能残留,
  //  先清理孤儿目录释放磁盘,再恢复录制状态;同时清理无主的兼容转码临时文件)
  const orphanDirs = recorderService.cleanupOrphanedSegmentDirs();
  if (orphanDirs > 0) {
    console.log(`[capturehub] 启动恢复: 清理了 ${orphanDirs} 个残留 Stripchat 分片目录`);
  }
  const orphanCompat = recorderService.cleanupOrphanedCompatFiles();
  if (orphanCompat > 0) {
    console.log(`[capturehub] 启动恢复: 清理了 ${orphanCompat} 个残留兼容转码临时文件`);
  }
  const recovered = recorderService.recoverOrphanedRecordings('manual_stop');
  if (recovered > 0) {
    console.log(`[capturehub] 启动恢复: 清理了 ${recovered} 个残留录制状态，已触发后处理上传`);
  }

  console.log(`[capturehub] ROOT=${PATHS.root}`);
  console.log(`[capturehub] clientDist=${PATHS.clientDist}`);
  console.log(`[capturehub] clientDist exists=${fs.existsSync(PATHS.clientDist)}`);
  if (fs.existsSync(PATHS.clientDist)) {
    console.log(`[capturehub] clientDist files: ${fs.readdirSync(PATHS.clientDist).join(', ')}`);
  }

  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`[capturehub] listening on http://${HOST}:${PORT}`);
    console.log(`[capturehub] data=${PATHS.data}`);
    console.log(`[capturehub] recordings=${PATHS.recordings}`);
    console.log(
      `[capturehub] downloader=${settings.downloader} poll=${settings.pollIntervalSec}s segment=${settings.segmentDuration}`,
    );
  });

  monitorService.start();

  const shutdown = async (signal: string) => {
    console.log(`[capturehub] received ${signal}, shutting down...`);
    clearInterval(mouflonSyncTimer);
    monitorService.stop();
    await recorderService.stopAll('manual_stop');
    await botServerManager.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
