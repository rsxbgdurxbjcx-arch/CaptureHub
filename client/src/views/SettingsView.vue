<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { Ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, setToken, clearToken, getToken } from '../api';
import { useToast } from '../toast';
import { useAutoSave } from '../autoSave';
import { QUALITY_OPTIONS } from '../format';
import type { RecordQuality, Settings, SystemStatus, MouflonSyncStatus } from '../types';

const toast = useToast();
const router = useRouter();
const form = ref<Settings | null>(null);
const status = ref<SystemStatus | null>(null);
/** 应用版本号(仅前端展示用) */
const APP_VERSION = 'v2.4.1';
/** 表单是否已完成初始加载(加载前不触发自动保存) */
const ready = ref(false);

/** Stripchat Mouflon 密钥同步状态(参考 StripchatRecorder 设置页同步状态展示) */
const mouflonStatus = ref<MouflonSyncStatus | null>(null);
/** 是否正在手动同步 Mouflon 密钥 */
const syncingMouflon = ref(false);
let mouflonTimer: number | undefined;

/** 格式化 RFC 3339 时间戳为本地时间字符串(从未同步显示"从未") */
function formatTs(ts: string | null | undefined): string {
  if (!ts) return '从未';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

/** 加载 Mouflon 密钥同步状态 */
async function loadMouflonStatus(silent = false) {
  try {
    mouflonStatus.value = await api.getMouflonSyncStatus();
  } catch (e) {
    if (!silent) toast.error(e instanceof Error ? e.message : String(e));
  }
}

/** 手动触发一次 Mouflon 密钥同步(参考 StripchatRecorder syncKeys) */
async function syncMouflonNow() {
  if (!form.value?.stripchatMouflonSyncUrl?.trim()) {
    toast.warn('请先填写 Mouflon 密钥同步 Worker URL');
    return;
  }
  syncingMouflon.value = true;
  try {
    const result = await api.syncMouflonKeys();
    await loadMouflonStatus(true);
    toast.success(result.updated ? '已同步到新的 Mouflon 密钥' : 'Mouflon 密钥已是最新');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
    await loadMouflonStatus(true);
  } finally {
    syncingMouflon.value = false;
  }
}

const credForm = ref({
  username: '',
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
});
const savingCredentials = ref(false);
const loggingOut = ref(false);
/** 默认录制清晰度选择弹窗开关(受控,单次点击只切换一次) */
const qualityOpen = ref(false);

function qualityLabel(v: RecordQuality | string): string {
  const q = QUALITY_OPTIONS.find((x) => x.value === v);
  return q ? q.label : '';
}

function pickQuality(v: RecordQuality) {
  if (form.value) form.value.recordQuality = v;
  qualityOpen.value = false;
}

async function onLogout() {
  loggingOut.value = true;
  try {
    await api.logout();
  } catch { /* ignore */ }
  clearToken();
  toast.info('已退出登录');
  router.push('/login');
}

async function load() {
  try {
    const [s, st] = await Promise.all([api.getSettings(), api.status()]);
    form.value = s;
    status.value = st;
    ready.value = true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
  try {
    const authStatus = await api.authStatus();
    credForm.value.username = authStatus.username || '';
  } catch { /* ignore */ }
  // Stripchat Mouflon 密钥同步状态(独立获取,失败不影响页面)
  await loadMouflonStatus(true);
}

async function saveCredentials() {
  if (!credForm.value.username.trim()) {
    toast.warn('请输入账号');
    return;
  }
  if (!credForm.value.currentPassword) {
    toast.warn('请输入当前密码');
    return;
  }
  if (credForm.value.newPassword !== credForm.value.confirmPassword) {
    toast.warn('两次输入的新密码不一致');
    return;
  }
  savingCredentials.value = true;
  try {
    const data = await api.changeCredentials({
      username: credForm.value.username.trim(),
      currentPassword: credForm.value.currentPassword,
      newPassword: credForm.value.newPassword || undefined,
    });
    // 如果修改了密码,自动退出登录
    if (credForm.value.newPassword) {
      toast.success('密码已修改,即将退出登录,请使用新密码重新登录');
      setTimeout(() => {
        clearToken();
        router.push('/login');
      }, 1500);
    } else {
      setToken(data.token);
      credForm.value.currentPassword = '';
      credForm.value.newPassword = '';
      credForm.value.confirmPassword = '';
      toast.success('账号信息已更新');
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    savingCredentials.value = false;
  }
}

/**
 * 设置自动保存(统一机制):
 * - 输入防抖保存、失焦/回车立即保存、页面卸载 keepalive 保底保存
 * - 整体提交内容与旧"保存设置"按钮完全一致
 */
useAutoSave<Settings>({
  form: form as unknown as Ref<Settings>,
  ready,
  save: async (payload) => {
    await api.saveSettings({
      pollIntervalSec: Number(payload.pollIntervalSec),
      segmentDuration: payload.segmentDuration,
      segmentFileSize: payload.segmentFileSize,
      autoTranscode: payload.autoTranscode,
      cookieXhs: payload.cookieXhs,
      cookieDouyin: payload.cookieDouyin,
      cookieBilibili: payload.cookieBilibili,
      cookieKuaishou: payload.cookieKuaishou,
      cookieSoop: payload.cookieSoop,
      cookiePandalive: payload.cookiePandalive,
      cookieStripchat: payload.cookieStripchat,
      soopUsername: payload.soopUsername,
      soopPassword: payload.soopPassword,
      stripchatMouflonKeys: payload.stripchatMouflonKeys,
      stripchatMouflonSyncUrl: payload.stripchatMouflonSyncUrl,
      stripchatMouflonSyncToken: payload.stripchatMouflonSyncToken,
      recordQuality: payload.recordQuality,
      rcloneRemote: payload.rcloneRemote,
      rcloneRemotePath: payload.rcloneRemotePath,
      rcloneMode: payload.rcloneMode,
      rcloneDeleteLocalOnMove: payload.rcloneDeleteLocalOnMove,
      maxConcurrentRecordings: Number(payload.maxConcurrentRecordings),
      maxConcurrentUploads: Number(payload.maxConcurrentUploads),
    });
  },
  keepalive: (payload) => {
    const token = getToken();
    void fetch('/api/settings', {
      method: 'PUT',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  },
  validate: (payload) => {
    const checkNum = (v: unknown, min: number, max: number, label: string): string | null => {
      if (v === '' || v === null || v === undefined) return null;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return label;
      return null;
    };
    return (
      checkNum(payload.pollIntervalSec, 5, 3600, '轮询时间需在 5-3600 秒之间') ||
      checkNum(payload.maxConcurrentRecordings, -1, 1000, '最大并发录制允许 -1(不限)~ 1000') ||
      checkNum(payload.maxConcurrentUploads, 1, 20, '最大并发上传数需在 1-20 之间')
    );
  },
  onError: (msg) => toast.error(msg),
});

let statusTimer: number | undefined;

onMounted(() => {
  void load();
  // 实时无感刷新:每 1 秒刷新系统状态(版本/运行时间/工具可用性),
  // 不刷新正在编辑的表单,避免打断用户输入
  statusTimer = window.setInterval(async () => {
    try {
      status.value = await api.status();
    } catch { /* ignore */ }
  }, 1000);
  // Stripchat Mouflon 同步状态每 30 秒刷新(反映后端每小时自动同步结果)
  mouflonTimer = window.setInterval(() => void loadMouflonStatus(true), 30_000);
});

onUnmounted(() => {
  if (statusTimer) window.clearInterval(statusTimer);
  if (mouflonTimer) window.clearInterval(mouflonTimer);
});
</script>

<template>
  <div v-if="form" class="settings-view">
    <!-- 顶部标题栏(与"主播"页一致:标题左上,版本号右上,吸顶固定) -->
    <div class="page-header">
      <span class="page-title">设置</span>
      <span class="muted">{{ APP_VERSION }}</span>
    </div>

    <!-- 录制 -->
    <div class="card stack">
      <div class="item-title">录制设置</div>
      <div class="grid-2">
        <div class="field">
          <label class="label">轮询时间(秒)</label>
          <input v-model.number="form.pollIntervalSec" class="input" type="number" min="5" max="3600" />
          <div class="muted">最小 5 秒</div>
        </div>
        <div class="field">
          <label class="label">切片时长(HH:MM:SS)</label>
          <input v-model="form.segmentDuration" class="input" placeholder="留空不切片" />
          <div class="muted">留空不切片;填入时分秒自动切片</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="label">切片文件大小(MB)</label>
          <input v-model="form.segmentFileSize" class="input" type="number" step="1" min="0" placeholder="如 1950" />
          <div class="muted">留空不切片;达到此数值自动切片</div>
        </div>
        <div class="field">
          <label class="label">最大并发录制</label>
          <input v-model.number="form.maxConcurrentRecordings" class="input" type="number" min="-1" max="1000" />
          <div class="muted">-1不限制;允许范围 -1 ~ 1000</div>
        </div>
      </div>
      <div class="field">
        <label class="label">默认录制清晰度</label>
        <div class="quality-picker" @click="qualityOpen = true">
          <input
            class="input quality-input"
            :value="qualityLabel(form.recordQuality)"
            readonly
            placeholder="选择清晰度"
          />
          <span class="quality-arrow">▾</span>
        </div>
        <div class="muted">新建主播未单独设置时使用此清晰度</div>
      </div>
      <div class="switch">
        <div><div>MP4 容器</div><div class="muted">录制为 MP4 格式</div></div>
        <label class="toggle"><input v-model="form.autoTranscode" type="checkbox" /><span class="slider" /></label>
      </div>
    </div>

    <!-- 小红书 Cookie -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">小红书 Cookie</div>
      <div class="field">
        <label class="label">Cookie 字符串(需含 a1 + web_session)</label>
        <textarea v-model="form.cookieXhs" class="textarea" style="min-height:80px" placeholder="a1=...; web_session=...; ..." spellcheck="false" />
      </div>
    </div>

    <!-- 抖音 Cookie -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">抖音 Cookie</div>
      <div class="field">
        <label class="label">Cookie 字符串(需含 ttwid + msToken)</label>
        <textarea v-model="form.cookieDouyin" class="textarea" style="min-height:80px" placeholder="ttwid=...; msToken=...; ..." spellcheck="false" />
      </div>
    </div>

    <!-- 哔哩哔哩 Cookie -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">哔哩哔哩 Cookie</div>
      <div class="field">
        <label class="label">Cookie 字符串(需含 SESSDATA + buvid3)</label>
        <textarea v-model="form.cookieBilibili" class="textarea" style="min-height:80px" placeholder="SESSDATA=...; buvid3=...; ..." spellcheck="false" />
      </div>
    </div>

    <!-- 快手 Cookie -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">快手 Cookie</div>
      <div class="field">
        <label class="label">Cookie 字符串(需含 did + userId)</label>
        <textarea v-model="form.cookieKuaishou" class="textarea" style="min-height:80px" placeholder="did=web_xxx; userId=xxx; ..." spellcheck="false" />
      </div>
    </div>

    <!-- SOOP Cookie & 凭据 -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">SOOP</div>
      <div class="field">
        <label class="label">SOOP Cookie 字符串</label>
        <textarea v-model="form.cookieSoop" class="textarea" style="min-height:80px" placeholder="SOOP 平台 Cookie..." spellcheck="false" />
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="label">SOOP 用户名</label>
          <input v-model="form.soopUsername" class="input" placeholder="SOOP 账号用户名" autocomplete="off" />
        </div>
        <div class="field">
          <label class="label">SOOP 密码</label>
          <input v-model="form.soopPassword" class="input" type="password" placeholder="SOOP 账号密码" autocomplete="off" />
        </div>
      </div>
    </div>

    <!-- PandaLive Cookie -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">PandaLive Cookie</div>
      <div class="field">
        <label class="label">PandaLive Cookie 字符串</label>
        <textarea v-model="form.cookiePandalive" class="textarea" style="min-height:80px" placeholder="PandaLive 平台 Cookie..." spellcheck="false" />
      </div>
    </div>

    <!-- Stripchat Cookie & Mouflon 密钥 -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">Stripchat</div>
      <div class="field">
        <label class="label">Stripchat Cookie 字符串(可选)</label>
        <textarea v-model="form.cookieStripchat" class="textarea" style="min-height:80px" placeholder="Stripchat 平台 Cookie(公开秀无需登录,可留空)..." spellcheck="false" />
      </div>
      <div class="field">
        <label class="label">Mouflon 解密密钥(可选)</label>
        <textarea v-model="form.stripchatMouflonKeys" class="textarea" style="min-height:90px" placeholder="每行一条 pkey=pdkey,支持 # 注释" spellcheck="false" />
        <div class="muted">用于解密 Mouflon 加密的 HLS 分片文件名;留空则录制未加密的公开秀</div>
      </div>
      <div class="field">
        <label class="label">Mouflon 密钥同步 Worker URL</label>
        <input v-model="form.stripchatMouflonSyncUrl" class="input" placeholder="默认 https://mouflon.chantrail.com,留空则不自动同步" autocomplete="off" />
        <div class="muted">自动从该 Worker 拉取最新 Mouflon 密钥;留空禁用自动同步</div>
      </div>
      <div class="field">
        <label class="label">Mouflon 密钥同步 Token(可选)</label>
        <input v-model="form.stripchatMouflonSyncToken" class="input" placeholder="Worker 的鉴权 Token(可选)" autocomplete="off" />
      </div>

      <!-- 密钥同步状态(参考 StripchatRecorder 设置页:MouflonKeysStore 状态展示 + 手动同步按钮) -->
      <div class="mouflon-status-box">
        <div class="row space wrap">
          <div class="muted" style="margin:0">密钥同步状态</div>
          <button
            class="btn btn-sm btn-primary"
            :disabled="syncingMouflon || !form.stripchatMouflonSyncUrl?.trim()"
            @click="syncMouflonNow"
          >
            {{ syncingMouflon ? '同步中...' : '立即同步' }}
          </button>
        </div>
        <div class="mouflon-status-grid">
          <div class="mouflon-status-row">
            <span class="muted">可用密钥</span>
            <b>{{ mouflonStatus?.keyCount ?? '-' }} 条</b>
          </div>
          <div class="mouflon-status-row">
            <span class="muted">上次自动同步</span>
            <b>{{ formatTs(mouflonStatus?.autoSyncedAt) }}</b>
          </div>
          <div class="mouflon-status-row">
            <span class="muted">手动密钥更新</span>
            <b>{{ formatTs(mouflonStatus?.manualUpdatedAt) }}</b>
          </div>
          <div class="mouflon-status-row">
            <span class="muted">最近同步尝试</span>
            <b>{{ formatTs(mouflonStatus?.lastSyncAt) }}</b>
          </div>
        </div>
        <div v-if="mouflonStatus?.lastSyncError" class="muted err-text" style="margin-top:8px">
          上次同步失败: {{ mouflonStatus.lastSyncError }}
        </div>
        <div class="muted" style="margin-top:6px">
          自动同步: 启动时 + 每小时;手动密钥优先,Worker 密钥仅补充不覆盖
        </div>
      </div>
    </div>

    <!-- 系统状态 -->
    <div class="card" style="margin-top:12px" v-if="status">
      <div class="item-title" style="margin-bottom:8px">系统状态</div>
      <div class="status-grid">
        <div class="status-row"><span class="muted">版本</span><b>{{ APP_VERSION }}</b></div>
        <div class="status-row"><span class="muted">运行时间</span><b>{{ status.uptimeSec }} 秒</b></div>
        <div class="status-row"><span class="muted">ffmpeg</span><b :class="status.tools.ffmpeg ? 'ok' : 'err'">{{ status.tools.ffmpeg ? '✓' : '✗' }}</b></div>
        <div class="status-row"><span class="muted">rclone</span><b :class="status.tools.rclone ? 'ok' : 'err'">{{ status.tools.rclone ? '✓' : '✗' }}</b></div>
        <div class="status-row"><span class="muted">telegram-bot-api</span><b :class="status.tools.telegramBotApi ? 'ok' : 'err'">{{ status.tools.telegramBotApi ? '✓' : '✗' }}</b></div>
      </div>
    </div>

    <!-- 账号安全 -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">登录账号</div>
      <div class="field">
        <label class="label">账号</label>
        <input v-model="credForm.username" class="input" placeholder="登录账号" autocomplete="username" />
      </div>
      <div class="field">
        <label class="label">当前密码</label>
        <input v-model="credForm.currentPassword" class="input" type="password" placeholder="输入当前密码以验证" autocomplete="current-password" />
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="label">新密码(可选)</label>
          <input v-model="credForm.newPassword" class="input" type="password" placeholder="留空则不修改密码" autocomplete="new-password" />
        </div>
        <div class="field">
          <label class="label">确认新密码</label>
          <input v-model="credForm.confirmPassword" class="input" type="password" placeholder="再次输入新密码" autocomplete="new-password" />
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-primary" :disabled="savingCredentials" @click="saveCredentials">
          {{ savingCredentials ? '保存中...' : '修改账号' }}
        </button>
        <button class="btn btn-primary" :disabled="loggingOut" @click="onLogout">
          {{ loggingOut ? '退出中...' : '退出登录' }}
        </button>
      </div>
    </div>

    <!-- 默认录制清晰度选择弹窗(复用全局 modal 样式,受控开关防重复弹出) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="qualityOpen" class="modal-mask" @click.self="qualityOpen = false">
          <div class="modal quality-modal">
            <div class="modal-head">
              <h3>默认录制清晰度</h3>
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
  <div v-else class="card empty">加载中...</div>
</template>

<style scoped>
/* ---- Stripchat Mouflon 密钥同步状态框 ---- */
.mouflon-status-box {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--surface-2);
}
.mouflon-status-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.mouflon-status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.mouflon-status-row b {
  font-weight: 600;
  color: var(--foreground);
  text-align: right;
}
.err-text { color: var(--destructive); }

/* ---- 默认录制清晰度选择器(适配全局样式) ---- */
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

/* 默认录制清晰度弹窗:圆角适配 StripchatRecorder-MobileUI(18px) */
.quality-modal {
  border-radius: 18px;
}
</style>
