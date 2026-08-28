<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch, reactive } from 'vue';
import { api, snapshotUrl } from '../api';
import { useToast } from '../toast';
import { useConfirm } from '../confirm';
import { STATUS_LABELS, PLATFORM_LABELS, QUALITY_LABELS, QUALITY_OPTIONS, formatTime } from '../format';
import type { Streamer, Platform, RecordQuality } from '../types';

const toast = useToast();
const { confirm } = useConfirm();
const list = ref<Streamer[]>([]);
const loading = ref(false);
const modalOpen = ref(false);
const submitting = ref(false);
const editing = ref<Streamer | null>(null);
/** 头像加载失败记录(id → 失败时间戳,超时后自动重试,保证在线/离线卡片能显示头像) */
const imgFailed = ref<Record<string, number>>({});
/**
 * 主播头像缓存(id → { url, ts })
 * 头像仅在添加主播时获取一次并长久显示(离线/在线状态显示),
 * 后续不再重新获取。load() 时只对"首次见到"的主播缓存头像,
 * 已有缓存的主播保持原头像,不随每秒列表刷新变化。
 */
const avatarCache = ref<Record<string, { url: string; ts: number }>>({});
const refreshing = ref(false);
const selectedIds = ref<Set<string>>(new Set());
const copiedId = ref<string | null>(null);
/** 录制清晰度选择弹窗开关(受控,单次点击只切换一次) */
const qualityOpen = ref(false);
let timer: number | undefined;

const now = ref(Date.now());
let durationTimer: number | undefined;

/* ---- 直播画面快照(录制中卡片刷新)---- */
/**
 * 快照/缩略图刷新机制(仅区分 Stripchat 与其余平台):
 * - 非 Stripchat 平台:每 5 秒刷新一次(后端 ffmpeg 从直播流实时抓帧)
 * - Stripchat 平台:每 5 秒刷新一次(官方缩略图 URL,与后端监控轮询同步)
 */
const THUMB_REFRESH_MS = 5000;
const THUMB_REFRESH_STRIPCHAT_MS = 5000;
const thumbVersion = ref(Date.now());
/** 记录每个主播快照加载失败的版本号;版本号变化后自动重试 */
const snapFailedVersion = ref<Record<string, number>>({});
let thumbTimer: number | undefined;
let thumbTimerStripchat: number | undefined;

/* ---- Stripchat 官方缩略图(获取/刷新机制与 StripchatRecorder 一致)---- */
/** 支持的 CDN 顶级域名(与 StripchatRecorder useFastThumbnail 一致) */
const SC_CDN_TLDS = ['doppiocdn.com', 'doppiocdn.org', 'doppiocdn.live', 'doppiocdn.net'];
/** id → 官方缩略图 URL(5 秒节流取后端轮询更新的最新值) */
const stripchatThumb = ref<Record<string, string>>({});
/** id → 多 CDN 竞速后的最优 URL(未完成时回退原始 URL) */
const stripchatThumbResolved = ref<Record<string, string>>({});

/** 多 CDN 域名竞速(移植 StripchatRecorder useFastThumbnail.race):并行尝试,取最先加载成功者 */
async function raceScThumbnail(url: string): Promise<string> {
  const matched = SC_CDN_TLDS.find((tld) => url.includes(tld));
  if (!matched) return url;
  return Promise.any(
    SC_CDN_TLDS.map((tld) => new Promise<string>((resolve, reject) => {
      const candidate = url.replace(matched, tld);
      const img = new Image();
      img.onload = () => resolve(candidate);
      img.onerror = () => reject();
      img.src = candidate;
    })),
  ).catch(() => url);
}

/** 5 秒节流:从最新列表取 Stripchat 主播的官方缩略图 URL(URL 变化时清除失败标记以便重试) */
function refreshStripchatThumbs() {
  const next: Record<string, string> = {};
  for (const s of list.value) {
    if (s.platform === 'stripchat' && s.avatar) next[s.id] = s.avatar;
  }
  const failed = { ...imgFailed.value };
  for (const [id, url] of Object.entries(next)) {
    if (stripchatThumb.value[id] !== url) delete failed[id];
  }
  imgFailed.value = failed;
  stripchatThumb.value = next;
}

/** 监听官方缩略图变化 → 触发 CDN 竞速(竞速结果优先用于显示) */
watch(stripchatThumb, (map) => {
  for (const [id, url] of Object.entries(map)) {
    if (!url) continue;
    void raceScThumbnail(url).then((resolved) => {
      // 防陈旧:仅当该 id 当前 URL 仍为此 URL 时更新
      if (stripchatThumb.value[id] === url) {
        stripchatThumbResolved.value = { ...stripchatThumbResolved.value, [id]: resolved };
      }
    });
  }
}, { immediate: true });

const form = ref({
  profileUrl: '',
  name: '',
  platform: 'xhs' as Platform,
  redId: '',
  roomId: '',
  enabled: true,
  recordQuality: 'OD' as RecordQuality,
});

const hasStreamers = computed(() => list.value.length > 0);
const hasRecording = computed(() => list.value.some((s) => s.status === 'recording'));
const recordingCount = computed(() => list.value.filter((s) => s.status === 'recording').length);

/* ---- 长按多选 ---- */
const selectMode = ref(false);
let pressTimer: number | undefined;
let longPressTriggered = false;
let pressStartPos = { x: 0, y: 0 };

/** 实时录制时长 */
function recordingDuration(s: Streamer): string {
  if (s.status !== 'recording' || !s.lastLiveAt) return '';
  const start = new Date(s.lastLiveAt).getTime();
  if (Number.isNaN(start)) return '';
  const elapsed = Math.max(0, Math.floor((now.value - start) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const sec = elapsed % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// 仅在有录制中主播时启动秒级计时器
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

/** 根据 URL 自动推断平台 */
function autoDetectPlatform(url: string): Platform {
  if (/douyin\.com/i.test(url)) return 'douyin';
  if (/bilibili\.com|live\.bilibili/i.test(url)) return 'bilibili';
  if (/kuaishou\.com|live\.kuaishou/i.test(url)) return 'kuaishou';
  if (/sooplive|afreecatv/i.test(url)) return 'soop';
  if (/pandalive/i.test(url)) return 'pandalive';
  if (/stripchat/i.test(url)) return 'stripchat';
  return 'xhs';
}

// 监听 URL 变化自动推断平台
watch(() => form.value.profileUrl, (url) => {
  if (url && !editing.value) {
    const detected = autoDetectPlatform(url);
    if (detected !== form.value.platform) {
      form.value.platform = detected;
    }
  }
});

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const data = await api.listStreamers();
    // 头像缓存:仅在添加主播时获取一次并长久固定;
    // 只对"首次见到"的主播缓存头像,已有缓存的主播保持原头像(不随每秒刷新变化)
    const now = Date.now();
    const cache = { ...avatarCache.value };
    for (const s of data) {
      if (cache[s.id] === undefined) {
        cache[s.id] = { url: s.avatar || '', ts: now };
      }
    }
    avatarCache.value = cache;
    list.value = data;
  } catch (e) {
    if (!silent) toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
    refreshing.value = false;
    pruneAvatarFailures();
  }
}

/**
 * 获取主播头像:优先取缓存值,不随每秒列表刷新变化。
 * 仅当头像 URL 以 http:// 开头时统一转为 https:// ——
 * 修复 B 站 face 接口返回 http CDN 地址导致 https 页面下 <img>
 * 被浏览器混合内容拦截而无法显示的问题。
 * 注意:SOOP 头像为 https://profile.img.sooplive.co.kr 拼接机制,
 * 规则不命中,完全不受影响。
 */
function avatarOf(s: Streamer): string {
  const cached = avatarCache.value[s.id];
  const url = cached !== undefined ? cached.url : (s.avatar || '');
  return url.replace(/^http:\/\//i, 'https://');
}

/** 清除某主播的头像缓存(添加/编辑成功后调用,使新头像生效一次) */
function clearAvatarCache(id: string) {
  if (avatarCache.value[id] === undefined) return;
  const next = { ...avatarCache.value };
  delete next[id];
  avatarCache.value = next;
}

/** 清理超过 60 秒的头像加载失败标记,使头像自动重试加载 */
function pruneAvatarFailures() {
  const now = Date.now();
  let changed = false;
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(imgFailed.value)) {
    if (now - v < 60_000) next[k] = v;
    else changed = true;
  }
  if (changed) imgFailed.value = next;
}

/**
 * 头像加载失败处理
 * 记录失败时间戳, 60 秒后自动重试;持续失败则卡片显示占位符。
 * (SOOP 头像使用 profile.img.sooplive.co.kr 拼接机制, 无需 CDN 回退)
 */
function onAvatarError(s: Streamer) {
  imgFailed.value = { ...imgFailed.value, [s.id]: Date.now() };
}

async function onRefresh() {
  refreshing.value = true;
  await load(true);
}

function openAdd() {
  editing.value = null;
  form.value = {
    profileUrl: '',
    name: '',
    platform: 'xhs',
    redId: '',
    roomId: '',
    enabled: true,
    recordQuality: 'OD',
  };
  modalOpen.value = true;
}

function openEdit(s: Streamer) {
  editing.value = s;
  form.value = {
    profileUrl: s.profileUrl,
    name: s.name,
    platform: s.platform || 'xhs',
    redId: s.redId || '',
    roomId: s.roomId || '',
    enabled: s.enabled,
    recordQuality: s.recordQuality || 'OD',
  };
  modalOpen.value = true;
}

async function save() {
  if (!form.value.profileUrl.trim()) { toast.warn('请填写主页/直播链接'); return; }
  submitting.value = true;
  try {
    const body = {
      profileUrl: form.value.profileUrl.trim(),
      name: form.value.name.trim() || undefined,
      platform: form.value.platform,
      redId: form.value.redId.trim() || null,
      roomId: form.value.roomId.trim() || null,
      enabled: form.value.enabled,
      recordQuality: form.value.recordQuality,
    };
    if (editing.value) {
      await api.updateStreamer(editing.value.id, body);
      toast.success('已更新');
      // 编辑不重新获取头像;清除缓存后 load 重新缓存原头像(保持固定)
      clearAvatarCache(editing.value.id);
    } else {
      await api.createStreamer(body);
      toast.success('已添加');
    }
    modalOpen.value = false;
    await load(true);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    submitting.value = false;
  }
}

async function remove(s: Streamer) {
  if (!await confirm({ title: '删除主播', message: `确认删除主播「${s.name}」?`, danger: true })) return;
  try {
    await api.deleteStreamer(s.id);
    clearAvatarCache(s.id);
    toast.success('已删除');
    await load(true);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
  // 如果取消了所有选中,退出选择模式
  if (next.size === 0) selectMode.value = false;
}

function toggleSelectAll() {
  if (list.value.length > 0 && selectedIds.value.size === list.value.length) {
    selectedIds.value = new Set();
    selectMode.value = false;
  } else {
    selectedIds.value = new Set(list.value.map((s) => s.id));
  }
}

function exitSelectMode() {
  selectMode.value = false;
  selectedIds.value = new Set();
}

async function batchDelete() {
  if (selectedIds.value.size === 0) {
    toast.warn('请先选择要删除的主播');
    return;
  }
  if (!await confirm({ title: '批量删除', message: `确认删除选中的 ${selectedIds.value.size} 个主播?`, danger: true })) return;
  try {
    const ids = [...selectedIds.value];
    list.value = await api.batchDeleteStreamers(ids);
    // 清理被删除主播的头像缓存
    const next = { ...avatarCache.value };
    for (const id of ids) delete next[id];
    avatarCache.value = next;
    selectedIds.value = new Set();
    selectMode.value = false;
    toast.success('已删除选中主播');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

async function check(s: Streamer) {
  try {
    const updated = await api.checkStreamer(s.id);
    const idx = list.value.findIndex((x) => x.id === s.id);
    if (idx >= 0 && updated) list.value[idx] = updated;
    toast.success(`${updated?.name || s.name}: ${statusText(updated?.status || s.status)}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

async function stopRec(s: Streamer) {
  if (!await confirm({ title: '停止录制', message: `确认停止「${s.name}」的录制?`, danger: true })) return;
  try {
    // 乐观更新:立即将状态改为离线、关闭监控开关
    const idx = list.value.findIndex((x) => x.id === s.id);
    if (idx >= 0) list.value[idx] = { ...s, status: 'offline', enabled: false };
    // 1. 先关闭监控并落库:
    //    - 防止 monitor 在停止录制期间读到旧的 enabled=true 自动重新开录
    //    - 避免 1 秒列表刷新把开关从 DB 拉回开启(关→开→关 冲突的根源)
    if (s.enabled) {
      try {
        const updated = await api.updateStreamer(s.id, { enabled: false });
        const i2 = list.value.findIndex((x) => x.id === s.id);
        if (i2 >= 0 && updated) {
          list.value[i2] = { ...list.value[i2], enabled: updated.enabled };
        }
      } catch { /* ignore */ }
    }
    // 2. 再停止录制(后端 stop 已触发自动上传)
    const r = await api.stopStreamer(s.id);
    toast.info(r.stopped ? '已停止录制' : '当前未在录制');
    await load(true);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

async function startRec(s: Streamer) {
  try {
    const updated = await api.startStreamer(s.id);
    const idx = list.value.findIndex((x) => x.id === s.id);
    if (idx >= 0 && updated) list.value[idx] = updated;
    toast.success('已触发检测/开录');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

async function toggleEnabled(s: Streamer) {
  try {
    const updated = await api.updateStreamer(s.id, { enabled: !s.enabled });
    const idx = list.value.findIndex((x) => x.id === s.id);
    if (idx >= 0 && updated) list.value[idx] = updated;
    // 开启监控后,如果主播在线但未录制,立即触发录制
    if (!s.enabled && updated && updated.status === 'online' && updated.status !== 'recording') {
      await api.startStreamer(s.id);
      toast.success(`已开始录制 ${s.name}`);
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

async function copyStreamUrl(s: Streamer) {
  const url = s.profileUrl || '';
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      // 非安全上下文降级方案
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copiedId.value = s.id;
    toast.success('已复制链接');
    setTimeout(() => { copiedId.value = null; }, 2000);
  } catch {
    toast.error('复制失败');
  }
}

function statusText(s: string) { return STATUS_LABELS[s] || s; }
function platformText(p: string) { return PLATFORM_LABELS[p] || p; }
function qualityText(q: string | null) { return q ? (QUALITY_LABELS[q] || q) : ''; }

/* ---- Stripchat 秀状态勋章(仅 Stripchat 平台;参考 StripchatRecorder StreamerCard 状态徽章逻辑) ---- */
/** 秀状态文字:Stripchat 后端轮询时将 cam API 的 status 中文描述写入 title
 *  (公开秀/私密秀/票务秀/计时秀/群组秀/虚拟私密/P2P/等待/离线) */
function stripchatShowText(s: Streamer): string {
  return (s.title || '').trim();
}
/** 是否显示秀状态勋章:仅 Stripchat 且在线/录制中(离线时右上角已有"离线"徽章,不重复显示) */
function showStripchatShow(s: Streamer): boolean {
  if (s.platform !== 'stripchat') return false;
  if (s.status !== 'online' && s.status !== 'recording') return false;
  return !!stripchatShowText(s);
}
/** 秀状态勋章配色:公开秀绿色(同 StripchatRecorder 公开秀 green),其余秀类型琥珀色 */
function stripchatShowClass(s: Streamer): string {
  return stripchatShowText(s) === '公开秀' ? 'show-public' : 'show-other';
}
/** 弹窗选择器显示值(中文标签 + 代号) */
function qualityLabel(v: RecordQuality | string): string {
  const q = QUALITY_OPTIONS.find((x) => x.value === v);
  return q ? q.label : '';
}
/** 选中清晰度并立即关闭弹窗 */
function pickQuality(v: RecordQuality) {
  form.value.recordQuality = v;
  qualityOpen.value = false;
}

// 主播弹窗关闭时同步关闭清晰度弹窗,避免残留
watch(modalOpen, (open) => {
  if (!open) qualityOpen.value = false;
});

/* ---- 快照相关 ---- */
/** 快照版本号(仅非 Stripchat 平台使用;Stripchat 走官方缩略图通道) */
function snapshotVersionOf(s: Streamer): number {
  return thumbVersion.value;
}

/** 是否应显示直播快照(仅录制中状态显示直播间画面;Stripchat 使用官方缩略图,不走 ffmpeg 抓帧) */
function showSnapshot(s: Streamer): boolean {
  // Stripchat 平台使用官方缩略图(与 StripchatRecorder 一致),不请求 ffmpeg 抓帧快照
  if (s.platform === 'stripchat') return false;
  // 仅录制中状态显示直播画面快照;离线/未启用监控等显示主播头像
  if (s.status !== 'recording') return false;
  const failedAt = snapFailedVersion.value[s.id];
  // 快照加载失败的版本与当前版本相同时不显示(等待下一轮刷新重试)
  if (failedAt && failedAt === snapshotVersionOf(s)) return false;
  return true;
}

function snapshotSrc(s: Streamer): string {
  return snapshotUrl(s.id, snapshotVersionOf(s));
}

function onSnapError(id: string) {
  snapFailedVersion.value = { ...snapFailedVersion.value, [id]: thumbVersion.value };
}

/** Stripchat 官方缩略图 src(优先使用 CDN 竞速结果,竞速未完成时先用原始 URL) */
function stripchatThumbSrc(s: Streamer): string {
  const url = stripchatThumb.value[s.id] || '';
  if (!url) return '';
  return stripchatThumbResolved.value[s.id] || url;
}

/* ---- 长按多选 ---- */
function isInteractiveTarget(e: Event): boolean {
  const target = e.target as HTMLElement;
  return !!target.closest('button, label, input, select, .card-switch, .card-btn, .card-btn-copy, .card-remove-btn, .modal');
}

function onCardPressStart(e: TouchEvent | MouseEvent, s: Streamer) {
  if (isInteractiveTarget(e)) return;
  if (modalOpen.value) return;
  longPressTriggered = false;
  const pt = 'touches' in e ? e.touches[0] : e;
  pressStartPos = { x: pt.clientX, y: pt.clientY };
  pressTimer = window.setTimeout(() => {
    longPressTriggered = true;
    selectMode.value = true;
    toggleSelect(s.id);
    if (navigator.vibrate) navigator.vibrate(50);
  }, 500);
}

function onCardPressMove(e: TouchEvent | MouseEvent) {
  if (!pressTimer) return;
  const pt = 'touches' in e ? e.touches[0] : e;
  const dx = Math.abs(pt.clientX - pressStartPos.x);
  const dy = Math.abs(pt.clientY - pressStartPos.y);
  // 移动超过 10px 取消长按(用户在滚动页面)
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

function onCardClick(s: Streamer) {
  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }
  if (selectMode.value) {
    toggleSelect(s.id);
  } else {
    openEdit(s);
  }
}

const isDouyin = computed(() => form.value.platform === 'douyin');
const isBilibili = computed(() => form.value.platform === 'bilibili');
const isKuaishou = computed(() => form.value.platform === 'kuaishou');
const isSoop = computed(() => form.value.platform === 'soop');
const isPandalive = computed(() => form.value.platform === 'pandalive');
const isStripchat = computed(() => form.value.platform === 'stripchat');
const isXhs = computed(() => form.value.platform === 'xhs');

const urlLabel = computed(() => {
  if (isDouyin.value) return '抖音主页 / 直播链接 *';
  if (isBilibili.value) return 'B站直播间 / 用户主页链接 *';
  if (isKuaishou.value) return '快手直播间 / 用户主页链接 *';
  if (isSoop.value) return 'SOOP 主播主页 / 直播链接 *';
  if (isPandalive.value) return 'PandaLive 主播主页 / 直播链接 *';
  if (isStripchat.value) return 'Stripchat 主播主页 / 直播链接 *';
  return '小红书主页 / 直播 / 分享链接 *';
});

const urlPlaceholder = computed(() => {
  if (isDouyin.value) return '如 live.douyin.com/xxx 或 www.douyin.com/user/xxx';
  if (isBilibili.value) return '如 live.bilibili.com/12345678 或 space.bilibili.com/12345678';
  if (isKuaishou.value) return '如 live.kuaishou.com/u/xxx 或 live.kuaishou.com/xxx';
  if (isSoop.value) return '如 sooplive.com/xxx 或 live.sooplive.com/xxx';
  if (isPandalive.value) return '如 pandalive.co.kr/xxx 或 www.pandalive.co.kr/xxx';
  if (isStripchat.value) return '如 stripchat.com/username';
  return '小红书链接...';
});

const platforms: { value: Platform; label: string }[] = [
  { value: 'xhs', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: '哔哩哔哩' },
  { value: 'kuaishou', label: '快手' },
  { value: 'soop', label: 'SOOP' },
  { value: 'pandalive', label: 'PandaLive' },
  { value: 'stripchat', label: 'Stripchat' },
];

// 下拉刷新触摸
let touchStartY = 0;
function onTouchStart(e: TouchEvent) {
  if (window.scrollY === 0) touchStartY = e.touches[0].clientY;
}
function onTouchEnd(e: TouchEvent) {
  if (window.scrollY === 0 && touchStartY > 0) {
    const diff = e.changedTouches[0].clientY - touchStartY;
    if (diff > 80 && !refreshing.value) onRefresh();
  }
  touchStartY = 0;
}

onMounted(() => {
  void load();
  // 实时无感刷新:每 1 秒静默刷新主播列表(在线/离线/录制状态实时更新)
  timer = window.setInterval(() => void load(true), 1000);
  // 录制中卡片直播画面快照刷新:
  // 非 Stripchat 平台每 5 秒刷新一次(ffmpeg 实时抓帧)
  thumbTimer = window.setInterval(() => {
    thumbVersion.value = Date.now();
  }, THUMB_REFRESH_MS);
  // Stripchat 平台官方缩略图:立即取一次,之后每 5 秒随轮询刷新(与后端监控轮询同步)
  refreshStripchatThumbs();
  thumbTimerStripchat = window.setInterval(() => {
    refreshStripchatThumbs();
  }, THUMB_REFRESH_STRIPCHAT_MS);
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  if (durationTimer) window.clearInterval(durationTimer);
  if (thumbTimer) window.clearInterval(thumbTimer);
  if (thumbTimerStripchat) window.clearInterval(thumbTimerStripchat);
  document.removeEventListener('touchstart', onTouchStart);
  document.removeEventListener('touchend', onTouchEnd);
});
</script>

<template>
  <div class="streamers-view">
    <!-- 顶部标题栏(参考 StripchatRecorder-MobileUI):"主播"标题左上,"添加主播"按钮右上 -->
    <div class="page-header">
      <span class="page-title">主播</span>
      <button class="btn btn-primary add-streamer-btn" @click="openAdd">
        添加主播
      </button>
    </div>

    <!-- 统计 + 工具栏 -->
    <div class="toolbar">
      <div class="header-pills">
        <span class="streamer-count-text">
          共 {{ list.length }} 个主播<span v-if="recordingCount > 0">,{{ recordingCount }} 个录制中</span>
        </span>
        <span
          v-if="list.some((s) => s.status === 'recording')"
          class="count-pill count-pill-rec"
        >
          <span class="count-dot count-dot-rec" />
          {{ recordingCount }}
        </span>
        <span
          v-if="list.some((s) => s.status === 'online')"
          class="count-pill count-pill-online"
        >
          <span class="count-dot count-dot-online" />
          {{ list.filter((s) => s.status === 'online').length }}
        </span>
      </div>
      <div class="toolbar-actions">
        <template v-if="selectMode">
          <button class="btn btn-sm" @click="toggleSelectAll">
            {{ selectedIds.size === list.length && list.length > 0 ? '取消全选' : '全选' }}
          </button>
          <button
            class="btn btn-sm btn-danger"
            :disabled="selectedIds.size === 0"
            @click="batchDelete"
          >
            删除{{ selectedIds.size > 0 ? ` (${selectedIds.size})` : '' }}
          </button>
          <button class="btn btn-sm" @click="exitSelectMode">退出</button>
        </template>
      </div>
      <div v-if="refreshing" class="refresh-hint">刷新中...</div>
    </div>

    <!-- 骨架屏 -->
    <div v-if="loading && !hasStreamers" class="list">
      <div v-for="i in 6" :key="i" class="sk-card sk-card-grid" />
    </div>

    <!-- 空状态 -->
    <div v-else-if="!hasStreamers" class="md-card empty">
      暂无主播,请添加小红书、抖音、哔哩哔哩、快手、SOOP、PandaLive、Stripchat 主页/直播间链接
    </div>

    <!-- 主播卡片网格 -->
    <div v-else class="streamer-grid">
      <div
        v-for="s in list"
        :key="s.id"
        class="card streamer-card"
        :class="{
          'card-recording': s.status === 'recording',
          'card-online': s.status === 'online',
          'is-selected': selectedIds.has(s.id),
          'is-select-mode': selectMode,
        }"
        @click="onCardClick(s)"
        @touchstart.passive="onCardPressStart($event, s)"
        @touchmove.passive="onCardPressMove($event)"
        @touchend.passive="onCardPressEnd()"
        @mousedown="onCardPressStart($event, s)"
        @mousemove="onCardPressMove($event)"
        @mouseup="onCardPressEnd()"
        @mouseleave="onCardPressEnd()"
      >
        <!-- 缩略图区域 -->
        <div class="card-thumb">
          <!-- Stripchat:官方 CDN 缩略图(每 5 秒随轮询刷新 + 多 CDN 竞速) -->
          <img
            v-if="s.platform === 'stripchat' && stripchatThumbSrc(s) && !imgFailed[s.id]"
            :src="stripchatThumbSrc(s)"
            class="thumb-img"
            alt=""
            referrerpolicy="no-referrer"
            @error="onAvatarError(s)"
          />
          <!-- 直播画面快照(非 Stripchat 录制中,ffmpeg 实时抓帧,每 5 秒刷新) -->
          <img
            v-else-if="showSnapshot(s)"
            :key="`snap-${s.id}-${snapshotVersionOf(s)}`"
            :src="snapshotSrc(s)"
            class="thumb-img"
            alt=""
            referrerpolicy="no-referrer"
            @error="onSnapError(s.id)"
          />
          <!-- 头像(快照不可用或在线/离线时显示;取添加时的缓存,不随刷新变化) -->
          <img
            v-else-if="avatarOf(s) && !imgFailed[s.id]"
            :src="avatarOf(s)"
            class="thumb-img"
            alt=""
            referrerpolicy="no-referrer"
            @error="onAvatarError(s)"
          />
          <!-- 占位符 -->
          <div v-else class="thumb-placeholder">{{ (s.name || '?').slice(0, 1) }}</div>

          <!-- 选中标记 -->
          <div v-if="selectedIds.has(s.id)" class="thumb-selected-mark">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>

          <!-- 平台标签(左上) -->
          <span class="thumb-badge platform-badge" :class="s.platform">{{ platformText(s.platform) }}</span>

          <!-- 状态标签 + 录制脉冲(右上)— 无论开关状态都显示 -->
          <span class="thumb-badge status-badge" :class="s.status">
            <span v-if="s.status === 'recording'" class="rec-dot" />
            {{ statusText(s.status) }}
          </span>

          <!-- Stripchat 秀状态勋章(仅 Stripchat 在线/录制中时显示;平台勋章仍固定在左上角) -->
          <span
            v-if="showStripchatShow(s)"
            class="thumb-badge stripchat-show-badge"
            :class="stripchatShowClass(s)"
          >{{ stripchatShowText(s) }}</span>

          <!-- 录制时长(左下) -->
          <span
            v-if="s.status === 'recording' && recordingDuration(s)"
            class="thumb-duration"
          >{{ recordingDuration(s) }}</span>

          <!-- 清晰度标签(右下) -->
          <span v-if="s.recordQuality" class="thumb-quality">{{ qualityText(s.recordQuality) }}</span>
        </div>

        <!-- 内容区域 -->
        <div class="card-content">
          <!-- 第一行:主播名 + 移除按钮 -->
          <div class="card-row card-row-1">
            <span class="card-name" :title="s.name">{{ s.name }}</span>
            <button
              class="card-remove-btn"
              title="移除主播"
              @click.stop="remove(s)"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18"/>
                <path d="m6 6 12 12"/>
              </svg>
            </button>
          </div>

          <!-- 第二行:录制/停止按钮 + 自动录制开关 + 复制链接 -->
          <div class="card-row card-row-2">
            <button
              v-if="s.status !== 'recording'"
              class="card-btn card-btn-primary"
              :disabled="!s.enabled || s.status === 'offline'"
              :title="!s.enabled ? '请先开启监控' : s.status === 'offline' ? '主播离线,无法录制' : ''"
              @click.stop="startRec(s)"
            >录制</button>
            <button
              v-else
              class="card-btn card-btn-danger"
              @click.stop="stopRec(s)"
            >停止</button>

            <label class="card-switch" title="上线自动录制" @click.stop>
              <input
                type="checkbox"
                :checked="s.enabled"
                @change="toggleEnabled(s)"
              />
              <span class="card-switch-track"></span>
            </label>

            <button
              class="card-btn-copy"
              :title="`复制链接\n${s.profileUrl}`"
              @click.stop="copyStreamUrl(s)"
            >
              <svg v-if="copiedId === s.id" class="copy-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 6 9 17l-5-5"/>
              </svg>
              <svg v-else width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
              </svg>
            </button>
          </div>

          <!-- 错误信息(仅显示真正的解析错误,不显示"暂未检测到开播"离线提示) -->
          <div v-if="s.lastError && s.status === 'parse_error'" class="card-error">⚠ {{ s.lastError }}</div>
        </div>
      </div>
    </div>

    <!-- 弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="modalOpen" class="modal-mask" @click.self="modalOpen = false">
          <div class="modal streamer-modal">
            <div class="modal-head">
              <h3>{{ editing ? '编辑主播' : '添加主播' }}</h3>
              <button class="icon-btn" @click="modalOpen = false">✕</button>
            </div>
            <div class="field">
              <label class="label">平台</label>
              <div class="platform-switch">
                <button
                  v-for="p in platforms"
                  :key="p.value"
                  class="platform-opt"
                  :class="{ active: form.platform === p.value }"
                  @click="form.platform = p.value"
                >{{ p.label }}</button>
              </div>
            </div>
            <div class="field">
              <label class="label">{{ urlLabel }}</label>
              <input
                v-model="form.profileUrl"
                class="input"
                :placeholder="urlPlaceholder"
              />
            </div>
            <div class="field">
              <label class="label">显示名称(可选)</label>
              <input v-model="form.name" class="input" placeholder="自动解析" />
            </div>
            <div class="grid-2">
              <div class="field" v-if="isXhs">
                <label class="label">小红书号 redId</label>
                <input v-model="form.redId" class="input" placeholder="自动解析优先" />
              </div>
              <div class="field">
                <label class="label">roomId</label>
                <input v-model="form.roomId" class="input" :placeholder="isDouyin ? '抖音webRid' : isBilibili ? 'B站房间号(可留空自动解析)' : isKuaishou ? '快手用户ID(可留空自动解析)' : isSoop ? 'SOOP房间号(可留空自动解析)' : isPandalive ? 'PandaLive房间号(可留空自动解析)' : isStripchat ? 'Stripchat用户名(可留空自动解析)' : '每场会变化'" />
              </div>
            </div>
            <div class="field">
              <label class="label">录制清晰度</label>
              <div class="quality-picker" @click="qualityOpen = true">
                <input
                  class="input quality-input"
                  :value="qualityLabel(form.recordQuality)"
                  readonly
                  placeholder="选择清晰度"
                />
                <span class="quality-arrow">▾</span>
              </div>
            </div>
            <div class="switch">
              <div><div>启用监控</div><div class="muted">关闭后跳过自动轮询</div></div>
              <label class="toggle">
                <input v-model="form.enabled" type="checkbox" /><span class="slider" />
              </label>
            </div>
            <div class="actions" style="margin-top:16px">
              <button class="btn btn-primary" :disabled="submitting" @click="save">
                {{ submitting ? '保存中...' : '保存' }}
              </button>
              <button class="btn" @click="modalOpen = false">取消</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 录制清晰度选择弹窗(独立 Teleport,复用全局 modal 样式,受控开关) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="qualityOpen" class="modal-mask" @click.self="qualityOpen = false">
          <div class="modal quality-modal">
            <div class="modal-head">
              <h3>录制清晰度</h3>
              <button class="icon-btn" @click="qualityOpen = false">✕</button>
            </div>
            <div class="quality-options">
              <button
                v-for="q in QUALITY_OPTIONS"
                :key="q.value"
                class="quality-opt"
                :class="{ active: form.recordQuality === q.value }"
                @click="pickQuality(q.value)"
              >{{ q.label }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ============================================================
   StreamersView — Material Design compact card layout
   ============================================================ */

/* ---- 页面容器 ---- */
.streamers-view {
  display: flex;
  flex-direction: column;
}

/* ---- 顶部标题栏(参考 StripchatRecorder-MobileUI:标题左、按钮右) ---- */
.add-streamer-btn {
  flex: 0 0 auto;
  /* 尺寸对齐参考项目 Button 默认 size: h-9(36px) + px-4(16px) + text-sm(14px),
     覆盖移动端全局 .btn 的 34px 降高,使桌面/移动端均与参考项目一致 */
  height: 36px;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 500;
}

/* ---- 工具栏 ---- */
.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 12px;
}
.toolbar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-left: auto;
}
.header-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.streamer-count-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
}
.count-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  color: var(--foreground);
  white-space: nowrap;
}
.count-pill-rec {
  background: color-mix(in oklch, var(--destructive) 16%, transparent);
  border-color: color-mix(in oklch, var(--destructive) 35%, transparent);
  color: var(--destructive);
}
.count-pill-online {
  background: color-mix(in oklch, var(--ok) 16%, transparent);
  border-color: color-mix(in oklch, var(--ok) 35%, transparent);
  color: var(--ok);
}
.count-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.count-dot-total { background: var(--muted-foreground); }
.count-dot-rec {
  background: var(--destructive);
  animation: recPulse 1.4s ease-in-out infinite;
}
.count-dot-online { background: var(--ok); }

/* ---- 网格 ---- */
.streamer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}

/* ---- 主播卡片 ---- */
.streamer-card {
  padding: 0;
  overflow: hidden;
  min-width: 0; /* 防止头像/快照等大尺寸图片撑宽 grid 轨道,保证所有卡片等宽 */
  display: flex;
  flex-direction: column;
  cursor: pointer;
  border-radius: var(--radius-lg);
  position: relative;
  transition: box-shadow 0.22s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s ease;
}
.streamer-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--elev-3);
}
.streamer-card.card-recording {
  border-color: color-mix(in oklch, var(--destructive) 55%, transparent);
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--destructive) 22%, transparent),
    var(--elev-2);
}
.streamer-card.card-online {
  border-color: color-mix(in oklch, var(--ok) 50%, transparent);
}
.streamer-card.is-selected {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--primary) 50%, transparent),
    var(--elev-3);
}
.streamer-card.is-select-mode {
  cursor: pointer;
}

/* ---- 缩略图区域 ---- */
.card-thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  background: var(--surface-3);
  overflow: hidden;
}
.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-placeholder {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 30px;
  font-weight: 800;
  color: var(--primary-foreground);
  background: linear-gradient(135deg, oklch(0.62 0.2 16), oklch(0.48 0.21 20));
}

/* ---- 选中标记 ---- */
.thumb-selected-mark {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-foreground);
  display: grid;
  place-items: center;
  z-index: 4;
  box-shadow: var(--elev-2);
  animation: popIn 0.2s ease;
}
@keyframes popIn {
  from { transform: translateX(-50%) scale(0); }
  to { transform: translateX(-50%) scale(1); }
}

/* ---- 缩略图浮层标签(保留原有方位:平台左上、状态右上) ---- */
.thumb-badge {
  position: absolute;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  white-space: nowrap;
  letter-spacing: 0.02em;
  line-height: 1.3;
  color: #fff;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 平台标签(左上) */
.platform-badge {
  top: 6px;
  left: 6px;
}
.platform-badge.xhs { background: oklch(0.55 0.2 25 / 85%); }
.platform-badge.douyin { background: oklch(0.55 0.2 300 / 85%); }
.platform-badge.bilibili { background: oklch(0.55 0.18 250 / 85%); }
.platform-badge.kuaishou { background: oklch(0.65 0.18 55 / 85%); }
.platform-badge.soop { background: oklch(0.6 0.16 145 / 85%); }
.platform-badge.pandalive { background: oklch(0.6 0.13 180 / 85%); }
.platform-badge.stripchat { background: oklch(0.62 0.19 350 / 85%); }

/* 状态标签(右上)+ 录制脉冲指示 */
.status-badge {
  top: 6px;
  right: 6px;
  background: oklch(0 0 0 / 55%);
}
.status-badge.offline { background: oklch(0.3 0.005 60 / 78%); }
.status-badge.online { background: oklch(0.6 0.15 145 / 88%); color: #fff; }
.status-badge.recording { background: oklch(0.54 0.215 25 / 90%); color: #fff; }
.status-badge.parse_error,
.status-badge.error { background: oklch(0.54 0.215 25 / 85%); }
.status-badge.unknown { background: oklch(0.75 0.16 80 / 88%); color: #2a2a2a; }

/* ---- Stripchat 秀状态勋章(右上状态徽章下方;配色参考 StripchatRecorder 状态徽章:
   公开秀 green、其余在线秀类型 amber) ---- */
.stripchat-show-badge {
  top: 26px;
  right: 6px;
}
.stripchat-show-badge.show-public {
  background: oklch(0.62 0.16 145 / 90%);
}
.stripchat-show-badge.show-other {
  background: oklch(0.72 0.16 75 / 92%);
}

.rec-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  animation: recPulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
  box-shadow: 0 0 0 2px oklch(1 0 0 / 30%);
}

/* ---- 缩略图底部标签 ---- */
.thumb-duration {
  position: absolute;
  bottom: 6px;
  left: 6px;
  /* 尺寸与平台/状态徽章(.thumb-badge)同等:9px 字体 + 1px 5px 内边距 */
  font-size: 9px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #fff;
  background: oklch(0.54 0.215 25 / 85%);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  z-index: 2;
}
.thumb-quality {
  position: absolute;
  bottom: 6px;
  right: 6px;
  /* 尺寸与平台/状态徽章(.thumb-badge)同等:9px 字体 + 1px 5px 内边距 */
  font-size: 9px;
  font-weight: 600;
  color: var(--primary);
  background: color-mix(in oklch, var(--card) 88%, transparent);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  z-index: 2;
}

/* ---- 内容区域(参考 StripchatRecorder-MobileUI:仅两行,极紧凑) ---- */
.card-content {
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.card-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.card-row-1 { width: 100%; }
.card-row-2 { gap: 5px; }

.card-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-error {
  font-size: 11px;
  color: var(--destructive);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

/* ---- 移除按钮(参考 StripchatRecorder-MobileUI:
   ghost 无边框无背景 + 16×16(h-4 w-4) + Lucide X 图标(10px,size-2.5)
   + 默认 muted-foreground + hover 仅文字变红(destructive) ---- */
.card-remove-btn {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: color 0.15s;
}
.card-remove-btn:hover {
  color: var(--destructive);
}
.card-remove-btn:active { transform: scale(0.9); }
.card-remove-btn svg {
  display: block;
}

/* ---- 录制/停止按钮(紧凑,参考 Stripchat h-6) ---- */
.card-btn {
  flex: 1;
  height: 24px;
  min-width: 0;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: filter 0.15s, transform 0.1s;
}
.card-btn:active:not(:disabled) {
  transform: scale(0.965);
}
.card-btn-primary {
  background: var(--primary);
  color: var(--primary-foreground);
  box-shadow: var(--elev-1);
}
.card-btn-primary:hover:not(:disabled) { filter: brightness(1.07); }
.card-btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}
.card-btn-danger {
  background: var(--destructive);
  color: oklch(0.99 0.005 80);
  box-shadow: var(--elev-1);
}
.card-btn-danger:hover:not(:disabled) { filter: brightness(1.05); }

/* ---- 自动录制开关(紧凑) ---- */
.card-switch {
  flex: 0 0 auto;
  position: relative;
  display: inline-block;
  width: 32px;
  height: 20px;
  cursor: pointer;
}
.card-switch input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}
.card-switch-track {
  position: absolute;
  inset: 0;
  background: var(--input);
  border-radius: 999px;
  transition: background 0.2s;
  box-shadow: inset 0 1px 2px oklch(0 0 0 / 12%);
}
.card-switch-track::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--elev-1);
}
.card-switch input:checked + .card-switch-track {
  background: var(--primary);
}
.card-switch input:checked + .card-switch-track::before {
  transform: translateX(12px);
}

/* ---- 复制链接图标按钮(参考 StripchatRecorder-MobileUI:
   ghost 无边框 + Copy 图标(10px) + 复制成功绿色对勾) ---- */
.card-btn-copy {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  /* 与第一行删除按钮同宽(16px)且右缘同贴内边距,中轴自然垂直对齐 */
  margin-right: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background 0.15s, color 0.15s, transform 0.1s;
}
.card-btn-copy:hover {
  background: var(--surface-3);
  color: var(--primary);
}
.card-btn-copy:active { transform: scale(0.9); }
.card-btn-copy .copy-check {
  color: var(--ok);
}

/* ---- 刷新提示 ---- */
.refresh-hint {
  color: var(--muted-foreground);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.refresh-hint::before {
  content: '';
  width: 13px;
  height: 13px;
  border: 2px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

/* ---- 骨架屏(网格占位) ---- */
.sk-card-grid {
  height: 180px;
}

/* ---- 平台选择器(弹窗内) ----
   圆角适配全局按钮样式(如"保存配置"按钮 10px / --radius-sm) */
.platform-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.platform-opt {
  flex: 1 1 calc(33.333% - 8px);
  min-width: 80px;
  padding: 10px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  box-shadow: var(--elev-1);
  transition: background-color 0.18s ease, box-shadow 0.18s ease,
    transform 0.12s ease, filter 0.18s ease;
}
.platform-opt:active {
  transform: scale(0.96);
  box-shadow: var(--elev-1);
}
.platform-opt:hover:not(.active) {
  background: var(--surface-2);
  filter: brightness(1.02);
}
.platform-opt.active {
  background: var(--primary);
  color: var(--primary-foreground);
  box-shadow: var(--elev-2);
}

/* ---- 录制清晰度选择器(适配全局样式) ---- */
.quality-picker {
  position: relative;
}
.quality-input {
  cursor: pointer;
  padding-right: 36px;
}
.quality-arrow {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--muted-foreground);
  font-size: 12px;
}
.quality-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.quality-opt {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  transition: color 0.15s, background-color 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.quality-opt:hover {
  border-color: var(--primary);
}
.quality-opt.active {
  background: var(--primary);
  color: var(--primary-foreground);
  border-color: transparent;
  box-shadow: var(--elev-2);
}

/* 录制清晰度弹窗:圆角适配 StripchatRecorder-MobileUI(18px) */
.quality-modal {
  border-radius: 18px;
}

/* ---- 动画 ---- */
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes recPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.3; transform: scale(1.4); }
}

/* ---- 响应式 ---- */
@media (max-width: 767px) {
  /* 移动端 2 列紧凑卡片(参考 StripchatRecorder-MobileUI) */
  .streamer-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .count-pill { font-size: 11px; padding: 3px 8px; }
  .card-error { font-size: 10px; }
  .sk-card-grid { height: 150px; }
  .md-fab { padding: 0 16px; }
  .md-fab span { display: none; }
}

@media (max-width: 380px) {
  .streamer-grid { gap: 12px; }
  .thumb-badge { font-size: 8px; padding: 1px 4px; }
  /* 画质徽章与平台/状态徽章完全同步(移动端缩小) */
  .thumb-quality { font-size: 8px; padding: 1px 4px; }
  /* 录制时长徽章与平台/状态徽章完全同步(移动端缩小) */
  .thumb-duration { font-size: 8px; padding: 1px 4px; }
}

/* ---- 减少动效 ---- */
@media (prefers-reduced-motion: reduce) {
  .streamer-card,
  .card-btn,
  .card-btn-copy,
  .card-remove-btn,
  .platform-opt {
    transition: none;
  }
  .count-dot-rec,
  .rec-dot {
    animation: none;
  }
}
</style>
