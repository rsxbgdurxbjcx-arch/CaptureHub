<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch, nextTick } from 'vue';
import { api, mediaUrl, getToken } from '../api';
import { useToast } from '../toast';
import { useConfirm } from '../confirm';
import { STATUS_LABELS, formatBytes, formatTime } from '../format';
import type { RecordingFile } from '../types';

const toast = useToast();
const { confirm } = useConfirm();
const list = ref<RecordingFile[]>([]);
const loading = ref(false);
const preview = ref<RecordingFile | null>(null);
const playerEl = ref<HTMLVideoElement | null>(null);
const refreshing = ref(false);
const deletingBatch = ref(false);
const selectedIds = ref<Set<string>>(new Set());
let timer: number | undefined;

const selectMode = ref(false);
let pressTimer: number | undefined;
let longPressTriggered = false;
let pressStartPos = { x: 0, y: 0 };

function isInteractiveTarget(e: Event): boolean {
  const target = e.target as HTMLElement;
  return !!target.closest('button, label, input, select, .modal');
}

function onCardPressStart(e: TouchEvent | MouseEvent, f: RecordingFile) {
  if (isInteractiveTarget(e)) return;
  longPressTriggered = false;
  const pt = 'touches' in e ? e.touches[0] : e;
  pressStartPos = { x: pt.clientX, y: pt.clientY };
  pressTimer = window.setTimeout(() => {
    longPressTriggered = true;
    selectMode.value = true;
    toggleSelect(f.id);
    if (navigator.vibrate) navigator.vibrate(50);
  }, 500);
}

function onCardPressMove(e: TouchEvent | MouseEvent) {
  if (!pressTimer) return;
  const pt = 'touches' in e ? e.touches[0] : e;
  const dx = Math.abs(pt.clientX - pressStartPos.x);
  const dy = Math.abs(pt.clientY - pressStartPos.y);
  if (dx > 10 || dy > 10) {
    window.clearTimeout(pressTimer);
    pressTimer = undefined;
  }
}

function onCardPressEnd() {
  if (pressTimer) {
    window.clearTimeout(pressTimer);
    pressTimer = undefined;
  }
}

function onCardClick(f: RecordingFile) {
  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }
  if (selectMode.value) {
    toggleSelect(f.id);
  } else {
    openPreview(f);
  }
}

// 上传进度(通过 SSE 实时推送,后端进度更新时即时下发)
const uploadProgress = ref<Record<string, {
  fileId: string;
  progress: number;
  speed: number;
  uploadedBytes: number;
  totalBytes: number;
  phase: string;
  startedAt: number;
}>>({});
let progressSource: EventSource | null = null;
const hasProcessing = computed(() => list.value.some((f) => f.status === 'processing'));

/** 建立 SSE 连接,实时接收进度推送 */
function connectProgressStream() {
  if (progressSource) return;
  const token = getToken();
  if (!token) return;
  const url = `/api/files/progress/stream?token=${encodeURIComponent(token)}`;
  progressSource = new EventSource(url);
  progressSource.onmessage = (ev) => {
    try {
      const p = JSON.parse(ev.data) as {
        fileId: string;
        progress: number;
        speed: number;
        uploadedBytes: number;
        totalBytes: number;
        phase: string;
        startedAt: number;
      };
      if (p && p.fileId) {
        uploadProgress.value = { ...uploadProgress.value, [p.fileId]: p };
      }
    } catch { /* ignore */ }
  };
  // EventSource 断线会自动重连,无需手动处理 onerror
}

/** 关闭 SSE 连接 */
function disconnectProgressStream() {
  progressSource?.close();
  progressSource = null;
}

// 无处理中文件时清空进度缓存(SSE 连接保持,等待下一次任务推送)
watch(hasProcessing, (processing) => {
  if (!processing) uploadProgress.value = {};
});

/** 格式化上传速度,统一以 MB/s 显示(真实数据) */
function formatSpeed(speedBps: number): string {
  if (!speedBps || speedBps <= 0) return '—';
  const mbps = speedBps / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

/** 获取处理中文件的进度阶段文本 */
function progressPhaseText(phase: string): string {
  if (phase === 'transcoding') return '转码中';
  if (phase === 'uploading') return '上传中';
  if (phase === 'finalizing') return '完成中';
  return '处理中';
}

// 实时录制时长(秒级计时器,仅在有录制中文件时运行)
const now = ref(Date.now());
let durationTimer: number | undefined;
const hasRecording = computed(() => list.value.some((f) => f.status === 'recording'));

watch(hasRecording, (recording) => {
  if (recording && !durationTimer) {
    durationTimer = window.setInterval(() => {
      now.value = Date.now();
    }, 1000);
  } else if (!recording && durationTimer) {
    window.clearInterval(durationTimer);
    durationTimer = undefined;
  }
}, { immediate: true });

// 录制中文件实时大小(通过 SSE 实时推送,后端短周期读取磁盘真实字节数)
const liveSizes = ref<Record<string, number>>({});
let sizeSource: EventSource | null = null;

/** 建立录制中文件大小 SSE 连接 */
function connectSizeStream() {
  if (sizeSource) return;
  const token = getToken();
  if (!token) return;
  sizeSource = new EventSource(`/api/files/sizes/stream?token=${encodeURIComponent(token)}`);
  sizeSource.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as Record<string, number>;
      if (data && typeof data === 'object') {
        liveSizes.value = data;
      }
    } catch { /* ignore */ }
  };
}

/** 关闭录制中文件大小 SSE 连接 */
function disconnectSizeStream() {
  sizeSource?.close();
  sizeSource = null;
}

/** 录制中文件显示实时大小,其余显示数据库大小 */
function displaySize(f: RecordingFile): number {
  if (f.status === 'recording' && liveSizes.value[f.id] !== undefined) {
    return liveSizes.value[f.id];
  }
  return f.size;
}

function recordingDuration(f: RecordingFile): string {
  if (f.status !== 'recording' || !f.createdAt) return '';
  const start = new Date(f.createdAt).getTime();
  if (Number.isNaN(start)) return '';
  const elapsed = Math.max(0, Math.floor((now.value - start) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const sec = elapsed % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// 选择相关
const allSelected = computed(
  () => list.value.length > 0 && list.value.every((f) => selectedIds.value.has(f.id)),
);

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
  if (next.size === 0) selectMode.value = false;
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(list.value.map((f) => f.id));
  }
}

function exitSelectMode() {
  selectMode.value = false;
  selectedIds.value = new Set();
}

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    list.value = await api.listFiles();
  } catch (e) {
    if (!silent) toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function onRefresh() {
  refreshing.value = true;
  await load(true);
}

async function batchDelete() {
  if (selectedIds.value.size === 0) {
    toast.info('请先选择文件');
    return;
  }
  const ids = [...selectedIds.value];
  if (!await confirm({ title: '批量删除', message: `确认删除选中的 ${ids.length} 个文件?`, danger: true })) return;
  deletingBatch.value = true;
  try {
    const updated = await api.batchDeleteFiles(ids);
    list.value = updated;
    selectedIds.value = new Set();
    const previewId = preview.value?.id;
    if (previewId && !updated.some((f) => f.id === previewId)) {
      preview.value = null;
    }
    toast.success(`已删除 ${ids.length} 个文件`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    deletingBatch.value = false;
  }
}

async function remove(f: RecordingFile) {
  if (!await confirm({ title: '删除文件', message: `删除本地文件「${f.filename}」?`, danger: true })) return;
  try {
    await api.deleteFile(f.id);
    toast.success('已删除');
    if (preview.value?.id === f.id) { preview.value = null; }
    if (selectedIds.value.has(f.id)) {
      const next = new Set(selectedIds.value);
      next.delete(f.id);
      selectedIds.value = next;
    }
    await load(true);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

async function upload(f: RecordingFile) {
  if (f.status === 'recording' || f.status === 'processing') return;
  try {
    toast.info('正在上传...');
    const updated = await api.uploadFile(f.id);
    if (!updated) {
      // move 模式:上传完成记录已被后端删除,立即移除卡片并同步服务端列表
      list.value = list.value.filter((x) => x.id !== f.id);
      const nextSel = new Set(selectedIds.value);
      nextSel.delete(f.id);
      selectedIds.value = nextSel;
      if (preview.value?.id === f.id) preview.value = null;
      toast.success('上传完成,卡片已删除');
      await load(true);
      return;
    }
    const idx = list.value.findIndex((x) => x.id === f.id);
    if (idx >= 0 && updated) list.value[idx] = updated;
    toast.success('上传完成');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

function canPlay(f: RecordingFile) {
  if (f.status === 'recording') return false;
  if (!f.absolutePath) return false;
  return /\.(mp4|webm|mkv|ts)$/i.test(f.filename);
}

function openPreview(f: RecordingFile) {
  if (!canPlay(f)) return;
  preview.value = f;
  nextTick(() => playerEl.value?.play().catch(() => undefined));
}

// 下拉刷新
let touchY = 0;
function onTS(e: TouchEvent) { if (window.scrollY === 0) touchY = e.touches[0].clientY; }
function onTE(e: TouchEvent) {
  if (window.scrollY === 0 && touchY > 0) {
    if (e.changedTouches[0].clientY - touchY > 80 && !refreshing.value) onRefresh();
  }
  touchY = 0;
}

onMounted(() => {
  void load();
  // 实时无感刷新:每 1 秒静默刷新文件列表(状态/卡片增删实时更新)
  timer = window.setInterval(() => void load(true), 1000);
  // 建立上传进度 SSE 实时推送连接
  connectProgressStream();
  // 建立录制中文件大小 SSE 实时推送连接
  connectSizeStream();
  document.addEventListener('touchstart', onTS, { passive: true });
  document.addEventListener('touchend', onTE, { passive: true });
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  if (durationTimer) window.clearInterval(durationTimer);
  disconnectProgressStream();
  disconnectSizeStream();
  document.removeEventListener('touchstart', onTS);
  document.removeEventListener('touchend', onTE);
});
</script>

<template>
  <div class="files-view">
    <!-- 顶部标题栏(与"主播"页一致:标题左上,数量右上,吸顶固定) -->
    <div class="page-header">
      <span class="page-title">文件</span>
      <span class="muted files-count">{{ list.length }} 个文件<span v-if="selectedIds.size"> · 已选 {{ selectedIds.size }}</span></span>
    </div>

    <!-- 选择模式工具栏 -->
    <div v-if="selectMode" class="toolbar select-mode-toolbar">
      <span class="muted">已选 {{ selectedIds.size }} 个文件</span>
      <button class="btn btn-sm" @click="toggleSelectAll">
        {{ allSelected ? '取消全选' : '全选' }}
      </button>
      <button class="btn btn-sm btn-danger" :disabled="selectedIds.size === 0" @click="batchDelete">
        删除选中
      </button>
      <button class="btn btn-sm" @click="exitSelectMode">退出</button>
    </div>

    <!-- 播放器 -->
    <div v-if="preview" class="card md-card elev-2" style="margin-bottom:12px">
      <div class="row space" style="margin-bottom:8px">
        <div class="item-title">▶ {{ preview.filename }}</div>
        <button class="btn btn-sm" @click="preview = null">关闭</button>
      </div>
      <video
        v-if="preview.absolutePath"
        ref="playerEl"
        class="player"
        controls
        playsinline
        webkit-playsinline
        :src="mediaUrl(preview.relativePath)"
      />
      <div v-else class="empty">本地文件已被移动或删除</div>
    </div>

    <div v-if="loading && !list.length" class="list">
      <div v-for="i in 3" :key="i" class="sk-card" />
    </div>

    <div v-else-if="!list.length" class="card empty">暂无录制文件</div>

    <div v-else class="list">
      <div
        v-for="f in list"
        :key="f.id"
        class="card file-card"
        :class="{ 'is-selected': selectedIds.has(f.id) }"
        @click="onCardClick(f)"
        @touchstart.passive="onCardPressStart($event, f)"
        @touchmove.passive="onCardPressMove($event)"
        @touchend.passive="onCardPressEnd()"
        @mousedown="onCardPressStart($event, f)"
        @mousemove="onCardPressMove($event)"
        @mouseup="onCardPressEnd()"
        @mouseleave="onCardPressEnd()"
      >
        <div class="row space wrap">
          <div class="row" style="gap:10px;align-items:center;flex:1;min-width:0">
            <div class="item-title">{{ f.filename }}</div>
          </div>
          <span class="badge" :class="f.status">{{ STATUS_LABELS[f.status] || f.status }}</span>
        </div>
        <div class="item-sub">
          👤 {{ f.streamerName }} · 📦 <span :class="{ 'live-size': f.status === 'recording' }">{{ formatBytes(displaySize(f)) }}</span> · {{ f.format.toUpperCase() }}
          <span v-if="f.status === 'processing' && f.uploadTool" class="upload-tool-badge">
            {{ f.uploadTool }} · {{ f.uploadMode || 'move' }}
          </span>
        </div>
        <!-- 处理中:实时显示上传速度和进度 -->
        <div v-if="f.status === 'processing' && uploadProgress[f.id]" class="upload-progress-bar-wrap">
          <div class="upload-progress-info">
            <span class="upload-phase">{{ progressPhaseText(uploadProgress[f.id].phase) }}</span>
            <span class="upload-percent">{{ uploadProgress[f.id].progress }}%</span>
            <span class="upload-speed">{{ formatSpeed(uploadProgress[f.id].speed) }}</span>
          </div>
          <div class="upload-progress-track">
            <div class="upload-progress-fill" :style="{ width: uploadProgress[f.id].progress + '%' }" />
          </div>
        </div>
        <!-- 处理中但暂无进度数据(如转码阶段尚未上报) -->
        <div v-else-if="f.status === 'processing'" class="item-sub processing-hint">
          ⏳ 处理中...
        </div>
        <div class="item-sub" v-if="f.status === 'recording' && recordingDuration(f)">
          <span class="recording-duration">{{ recordingDuration(f) }}</span>
        </div>
        <div class="item-sub">🕒 {{ formatTime(f.createdAt) }}</div>
        <div class="item-sub" v-if="f.remotePath" style="color:var(--ok)">☁ {{ f.remotePath }}</div>
        <div class="item-sub" v-if="f.error" style="color:var(--err)">⚠ {{ f.error }}</div>
        <div class="actions">
          <button class="btn btn-sm" :disabled="!canPlay(f)" @click="openPreview(f)">播放</button>
          <button
            class="btn btn-sm btn-primary"
            :disabled="f.status === 'recording' || f.status === 'processing'"
            @click="upload(f)"
          >
            上传
          </button>
          <button class="btn btn-sm btn-danger" @click="remove(f)">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 块级自然堆叠(不用 flex 容器,避免影响吸顶标题的 sticky 定位) */

.files-count {
  font-size: 12.5px;
  white-space: nowrap;
}

.refresh-hint {
  color: var(--muted-foreground);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.refresh-hint::before {
  content: '';
  width: 13px; height: 13px;
  border: 2px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.upload-tool-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  margin-left: 4px;
  background: color-mix(in oklch, var(--info) 15%, transparent);
  color: var(--info);
  border: 1px solid color-mix(in oklch, var(--info) 25%, transparent);
  white-space: nowrap;
  vertical-align: middle;
}

/* 录制中文件实时大小(高亮 + 等宽数字,每秒跳动) */
.live-size {
  font-weight: 700;
  color: var(--destructive);
  font-variant-numeric: tabular-nums;
}

/* ---- 上传进度条 ---- */
.upload-progress-bar-wrap {
  margin: 4px 0 2px;
}
.upload-progress-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 3px;
}
.upload-phase {
  color: var(--primary);
  white-space: nowrap;
}
.upload-percent {
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
}
.upload-speed {
  color: var(--ok);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.upload-progress-track {
  width: 100%;
  height: 5px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
}
.upload-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), color-mix(in oklch, var(--primary) 70%, var(--ok)));
  border-radius: 999px;
  transition: width 0.5s ease;
}
.processing-hint {
  color: var(--muted-foreground);
  font-size: 11px;
  margin: 2px 0;
}

.file-card {
  transition: box-shadow 0.2s ease, border-color 0.2s ease, transform 0.15s ease;
}
.file-card.is-selected {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--primary) 40%, transparent),
    var(--elev-2);
}
</style>
