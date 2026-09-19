<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, getToken } from '../api';
import { useToast } from '../toast';
import { useConfirm } from '../confirm';
import { useAutoSave } from '../autoSave';
import { STATUS_LABELS, TRIGGER_LABELS, formatTime } from '../format';
import type {
  PostProcessJob,
  PostProcessConfig,
  UploadTool,
  GrammyMode,
  RcloneMode,
  BotServerStatus,
  RcloneStatus,
} from '../types';

const BOT_SERVER_STATUS_TEXT: Record<BotServerStatus['status'], string> = {
  running: '运行中',
  stopped: '已停止',
  starting: '启动中',
  error: '错误',
};

const toast = useToast();
const { confirm } = useConfirm();
const jobs = ref<PostProcessJob[]>([]);
const clearing = ref(false);
const logJob = ref<PostProcessJob | null>(null);
const configLoaded = ref(false);

const botServerStatus = ref<BotServerStatus | null>(null);
const startingServer = ref(false);
const stoppingServer = ref(false);
/** 上传器选择弹窗开关(受控,单次点击只切换一次) */
const uploaderOpen = ref(false);

const UPLOADER_OPTIONS: { value: UploadTool; label: string }[] = [
  { value: 'grammy', label: 'grammY' },
  { value: 'rclone', label: 'rclone' },
];

/** 弹窗选择器显示值 */
function uploaderLabel(v: UploadTool | string): string {
  const o = UPLOADER_OPTIONS.find((x) => x.value === v);
  return o ? o.label : '';
}

/** 选中上传器并立即关闭弹窗 */
function pickUploader(v: UploadTool) {
  form.value.uploadTool = v;
  uploaderOpen.value = false;
}

/** grammY 模式选择弹窗开关(受控,单次点击只切换一次) */
const grammyModeOpen = ref(false);

const GRAMMY_MODE_OPTIONS: { value: GrammyMode; label: string }[] = [
  { value: 'move', label: 'move' },
  { value: 'copy', label: 'copy' },
];

/** 弹窗选择器显示值 */
function grammyModeLabel(v: GrammyMode | string): string {
  const o = GRAMMY_MODE_OPTIONS.find((x) => x.value === v);
  return o ? o.label : '';
}

/** 选中 grammY 模式并立即关闭弹窗 */
function pickGrammyMode(v: GrammyMode) {
  form.value.grammyMode = v;
  grammyModeOpen.value = false;
}

/** rclone 模式选择弹窗开关(受控,单次点击只切换一次) */
const rcloneModeOpen = ref(false);

const RCLONE_MODE_OPTIONS: { value: RcloneMode; label: string }[] = [
  { value: 'move', label: 'move' },
  { value: 'copy', label: 'copy' },
];

/** 弹窗选择器显示值 */
function rcloneModeLabel(v: RcloneMode | string): string {
  const o = RCLONE_MODE_OPTIONS.find((x) => x.value === v);
  return o ? o.label : '';
}

/** 选中 rclone 模式并立即关闭弹窗 */
function pickRcloneMode(v: RcloneMode) {
  form.value.rcloneMode = v;
  rcloneModeOpen.value = false;
}

/** ---------- rclone 网盘配置(账号密码自动生成配置) ---------- */

const rcloneStatus = ref<RcloneStatus | null>(null);
/** 网盘类型选择弹窗开关 */
const rcloneProviderOpen = ref(false);
const rcloneAccount = ref('');
const rclonePassword = ref('');
const savingRclone = ref(false);

/** 网盘类型显示值(列表由后端提供,仅含支持账号密码登录的网盘) */
function rcloneProviderLabel(v: string): string {
  if (!v) return '';
  const o = (rcloneStatus.value?.providers || []).find((x) => x.id === v);
  return o ? o.label : v;
}

/** 选中网盘类型并立即关闭弹窗(随后由自动保存机制落库) */
function pickRcloneProvider(v: string) {
  form.value.rcloneProvider = v;
  rcloneProviderOpen.value = false;
}

async function loadRcloneStatus(force = false) {
  try {
    rcloneStatus.value = await api.getRcloneStatus(force);
  } catch { /* ignore */ }
}

/** 连接状态仅展示真实结果:已连接 / 未连接(检测在后台静默进行,不展示过程状态) */
const rcloneStatusText = computed(() => {
  return rcloneStatus.value?.connected ? '已连接' : '未连接';
});

const rcloneStatusClass = computed(() => {
  return rcloneStatus.value?.connected ? 'ok' : 'err';
});

const rcloneConfigured = computed(() => !!rcloneStatus.value?.configured);

/** 保存网盘账号密码 → 后端自动生成/更新 rclone 配置并验证连接 */
async function saveRcloneConfig() {
  const provider = form.value.rcloneProvider;
  const account = rcloneAccount.value.trim();
  const password = rclonePassword.value;
  if (!provider || !account || !password || savingRclone.value) return;
  savingRclone.value = true;
  try {
    const data = await api.connectRclone({ provider, account, password });
    // 仅当输入未被修改时清空(避免清掉用户的后续输入);凭据不回显、不保留在表单中
    if (rcloneAccount.value.trim() === account) rcloneAccount.value = '';
    if (rclonePassword.value === password) rclonePassword.value = '';
    toast.success(`已保存 ${data.providerLabel || data.provider} 配置,正在验证连接`);
    void loadRcloneStatus(true);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    savingRclone.value = false;
  }
}

/** 填写账号与密码后自动保存并连接(输入防抖;若上次保存仍在进行则等完成后重试) */
let rcloneSaveTimer: number | undefined;

function scheduleRcloneSave() {
  if (rcloneSaveTimer) window.clearTimeout(rcloneSaveTimer);
  const account = rcloneAccount.value.trim();
  const password = rclonePassword.value;
  if (!account || !password || !form.value.rcloneProvider) return;
  rcloneSaveTimer = window.setTimeout(() => {
    rcloneSaveTimer = undefined;
    if (savingRclone.value) {
      scheduleRcloneSave();
      return;
    }
    void saveRcloneConfig();
  }, 1500);
}

watch([rcloneAccount, rclonePassword], () => {
  scheduleRcloneSave();
});

const form = ref<PostProcessConfig>({
  uploadTool: 'grammy',
  postProcessScript: '',
  postProcessOnStreamEnd: true,
  postProcessOnManualStop: true,
  postProcessOnSegment: true,
  rcloneProvider: 'pikpak',
  rcloneRemote: 'pikpak',
  rcloneRemotePath: 'capturehub',
  rcloneMode: 'move',
  rcloneDeleteLocalOnMove: true,
  maxConcurrentUploads: 3,
  grammyBotToken: '',
  grammyChatId: '',
  grammyApiId: '',
  grammyApiHash: '',
  grammyLocalPort: 8081,
  grammyMode: 'move',
  telegramBotApiPath: '',
  grammyMaxConcurrentUploads: 1,
});

let dataTimer: number | undefined;
let statusTimer: number | undefined;
let rcloneTimer: number | undefined;

/**
 * 后处理配置自动保存(统一机制):
 * - 输入防抖保存、失焦/回车立即保存、页面卸载 keepalive 保底保存
 * - 整体提交 {...form},与旧"保存配置"按钮提交内容完全一致
 */
useAutoSave<PostProcessConfig>({
  form,
  ready: configLoaded,
  save: async (payload) => {
    await api.savePostConfig({ ...payload });
  },
  keepalive: (payload) => {
    const token = getToken();
    void fetch('/api/postprocess/config', {
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
      checkNum(payload.maxConcurrentUploads, 1, 20, '最大并发上传数需在 1-20 之间') ||
      checkNum(payload.grammyMaxConcurrentUploads, 1, 20, 'grammY 最大并发上传需在 1-20 之间') ||
      checkNum(payload.grammyLocalPort, 1, 65535, 'Local Server Port 需在 1-65535 之间')
    );
  },
  onError: (msg) => toast.error(msg),
});

async function loadConfig() {
  const cfg = await api.getPostConfig();
  const d = (cfg || {}) as unknown as Record<string, unknown>;
  form.value = {
    uploadTool: (d.uploadTool as UploadTool) || 'grammy',
    postProcessScript: String(d.postProcessScript || ''),
    postProcessOnStreamEnd: Boolean(d.postProcessOnStreamEnd),
    postProcessOnManualStop: Boolean(d.postProcessOnManualStop),
    postProcessOnSegment: Boolean(d.postProcessOnSegment),
    rcloneProvider: String(d.rcloneProvider || 'pikpak'),
    rcloneRemote: String(d.rcloneRemote || 'pikpak'),
    rcloneRemotePath: String(d.rcloneRemotePath || 'capturehub'),
    rcloneMode: (d.rcloneMode as RcloneMode) || 'move',
    rcloneDeleteLocalOnMove: d.rcloneDeleteLocalOnMove === undefined ? true : Boolean(d.rcloneDeleteLocalOnMove),
    maxConcurrentUploads: Number(d.maxConcurrentUploads) || 3,
    grammyBotToken: String(d.grammyBotToken || ''),
    grammyChatId: String(d.grammyChatId || ''),
    grammyApiId: String(d.grammyApiId || ''),
    grammyApiHash: String(d.grammyApiHash || ''),
    grammyLocalPort: Number(d.grammyLocalPort) || 8081,
    grammyMode: (d.grammyMode as GrammyMode) || 'move',
    telegramBotApiPath: String(d.telegramBotApiPath || ''),
    grammyMaxConcurrentUploads: Number(d.grammyMaxConcurrentUploads) || 1,
  };
  configLoaded.value = true;
}

async function loadJobs(silent = false) {
  try {
    jobs.value = (await api.listJobs()) || [];
  } catch (e) {
    if (!silent) toast.error(e instanceof Error ? e.message : String(e));
  }
}

async function load(silent = false) {
  if (!configLoaded.value) await loadConfig();
  await loadJobs(silent);
}

async function loadBotServerStatus() {
  try {
    botServerStatus.value = await api.getBotServerStatus();
  } catch { /* ignore */ }
}

async function startBotServer() {
  startingServer.value = true;
  try {
    botServerStatus.value = await api.startBotServer();
    toast.success('Local Bot API Server 已启动');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    startingServer.value = false;
  }
}

async function stopBotServer() {
  stoppingServer.value = true;
  try {
    botServerStatus.value = await api.stopBotServer();
    toast.success('Local Bot API Server 已停止');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    stoppingServer.value = false;
  }
}

async function clearAllJobs() {
  if (!jobs.value.length) { toast.info('暂无任务记录'); return; }
  if (!await confirm({ title: '清除任务记录', message: `确认清除全部 ${jobs.value.length} 条任务记录?`, danger: true })) return;
  clearing.value = true;
  try {
    await api.clearJobs();
    await loadJobs(true);
    toast.success('已清除全部任务记录');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    clearing.value = false;
  }
}

async function copyLog() {
  if (!logJob.value?.log) { toast.warn('无日志内容'); return; }
  const text = logJob.value.log;
  try {
    // 优先使用 Clipboard API(需要 HTTPS 或 localhost 安全上下文)
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast.success('日志已复制');
      return;
    }
    // 回退方案:使用 textarea + execCommand(兼容 HTTP 部署环境)
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (ok) {
      toast.success('日志已复制');
    } else {
      toast.error('复制失败,请手动选择复制');
    }
  } catch {
    toast.error('复制失败,请手动选择复制');
  }
}

onMounted(() => {
  void load();
  void loadBotServerStatus();
  void loadRcloneStatus();
  // 静默刷新:每 1 秒刷新任务数据,每 1 秒轮询 Bot Server 状态,每 3 秒刷新 rclone 连接状态
  dataTimer = window.setInterval(() => void load(true), 1000);
  statusTimer = window.setInterval(() => void loadBotServerStatus(), 1000);
  rcloneTimer = window.setInterval(() => void loadRcloneStatus(), 3000);
});

onUnmounted(() => {
  if (dataTimer) window.clearInterval(dataTimer);
  if (statusTimer) window.clearInterval(statusTimer);
  if (rcloneTimer) window.clearInterval(rcloneTimer);
  if (rcloneSaveTimer) window.clearTimeout(rcloneSaveTimer);
});
</script>

<template>
  <div class="postprocess-view">
    <!-- 顶部标题栏(与"主播"页一致,吸顶固定) -->
    <div class="page-header">
      <span class="page-title">后处理</span>
    </div>

    <!-- 1. 上传工具选择(触发条件为后端默认功能,不在前端展示) -->
    <div class="card stack">
      <div class="item-title">上传器设置</div>

      <div class="field">
        <label class="label">上传器</label>
        <div class="quality-picker" @click="uploaderOpen = true">
          <input
            class="input quality-input"
            :value="uploaderLabel(form.uploadTool)"
            readonly
            placeholder="选择上传器"
          />
          <span class="quality-arrow">▾</span>
        </div>
      </div>
    </div>

    <!-- 2. grammY 配置 -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">grammY</div>

      <!-- Local Bot API Server 状态管理 -->
      <div class="bot-server-box">
        <div class="row space wrap">
          <div class="row" style="gap:8px">
            <span class="muted">Local Bot API Server</span>
            <span class="badge" :class="botServerStatus ? botServerStatus.status : 'stopped'">
              {{ botServerStatus ? BOT_SERVER_STATUS_TEXT[botServerStatus.status] : '加载中' }}
            </span>
          </div>
          <div class="row" style="gap:8px">
            <button
              class="btn btn-sm btn-primary"
              :disabled="startingServer || botServerStatus?.status === 'running'"
              @click="startBotServer"
            >
              {{ startingServer ? '启动中...' : '启动' }}
            </button>
            <button
              class="btn btn-sm btn-danger"
              :disabled="stoppingServer || botServerStatus?.status !== 'running'"
              @click="stopBotServer"
            >
              {{ stoppingServer ? '停止中...' : '停止' }}
            </button>
          </div>
        </div>
        <div v-if="botServerStatus?.status === 'running'" class="muted" style="margin-top:8px">
          PID: {{ botServerStatus.pid ?? '-' }} · 端口: {{ botServerStatus.port ?? '-' }}<template v-if="botServerStatus.apiRoot"> · API Root: {{ botServerStatus.apiRoot }}</template>
        </div>
        <div v-if="botServerStatus?.status === 'error' && botServerStatus.lastError" class="muted err-text" style="margin-top:8px">
          错误: {{ botServerStatus.lastError }}
        </div>
        <div v-if="botServerStatus?.restartCount" class="muted" style="margin-top:6px">
          自动重启次数: {{ botServerStatus.restartCount }}
        </div>
      </div>

      <div class="field">
        <label class="label">Bot Token</label>
        <input v-model="form.grammyBotToken" class="input" placeholder="123456:ABC-DEF..." autocomplete="off" />
      </div>

      <div class="grid-2">
        <div class="field">
          <label class="label">Chat ID</label>
          <input v-model="form.grammyChatId" class="input" placeholder="-1001234567890 或 -123456789" autocomplete="off" />
          <div class="muted" style="margin-top:4px">支持普通群组 ID 和 -100 开头的超级群组 ID</div>
        </div>
        <div class="field">
          <label class="label">API ID</label>
          <input v-model="form.grammyApiId" class="input" placeholder="API ID" autocomplete="off" />
        </div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label class="label">API Hash</label>
          <input v-model="form.grammyApiHash" class="input" placeholder="API Hash" autocomplete="off" />
        </div>
        <div class="field">
          <label class="label">Local Server Port</label>
          <input v-model.number="form.grammyLocalPort" class="input" type="number" min="1" max="65535" placeholder="8081" />
        </div>
      </div>

      <div class="field">
        <label class="label">grammY 模式</label>
        <div class="quality-picker" @click="grammyModeOpen = true">
          <input
            class="input quality-input"
            :value="grammyModeLabel(form.grammyMode)"
            readonly
            placeholder="选择模式"
          />
          <span class="quality-arrow">▾</span>
        </div>
      </div>

      <div class="field">
        <label class="label">最大并发上传</label>
        <input v-model.number="form.grammyMaxConcurrentUploads" class="input" type="number" min="1" max="20" />
        <div class="muted">grammY 同时上传的最大任务数(1-20,默认 1)</div>
      </div>
    </div>

    <!-- 3. rclone 配置(内置 rclone;账号密码自动生成配置) -->
    <div class="card stack" style="margin-top:12px">
      <div class="item-title">rclone</div>

      <!-- 连接状态 -->
      <div class="rclone-status-box">
        <div class="row" style="gap:8px">
          <span class="muted">连接状态</span>
          <span class="badge" :class="rcloneStatusClass">{{ rcloneStatusText }}</span>
        </div>
        <div v-if="rcloneStatus?.configured" class="muted" style="margin-top:6px">
          网盘: {{ rcloneStatus.providerLabel || rcloneStatus.provider }} · 远程名: {{ rcloneStatus.remoteName }} · 根目录: {{ rcloneStatus.rootPath }}
        </div>
        <div v-if="rcloneStatus?.lastError" class="muted err-text" style="margin-top:8px">
          错误: {{ rcloneStatus.lastError }}
        </div>
      </div>

      <div class="field">
        <label class="label">网盘类型</label>
        <div class="quality-picker" @click="rcloneProviderOpen = true">
          <input
            class="input quality-input"
            :value="rcloneProviderLabel(form.rcloneProvider)"
            readonly
            placeholder="选择网盘类型"
          />
          <span class="quality-arrow">▾</span>
        </div>
        <div class="muted">仅支持账号密码登录的网盘</div>
      </div>

      <div class="field">
        <label class="label">网盘账号</label>
        <input
          v-model="rcloneAccount"
          class="input"
          autocomplete="off"
          :placeholder="rcloneConfigured ? '已保存,如需更换请重新输入账号与密码' : '请输入网盘账号(邮箱/手机号)'"
        />
      </div>

      <div class="field">
        <label class="label">网盘密码</label>
        <input
          v-model="rclonePassword"
          class="input"
          type="password"
          autocomplete="new-password"
          :placeholder="rcloneConfigured ? '已保存,如需更换请重新输入' : '请输入网盘密码'"
        />
      </div>

      <div class="muted">填写网盘账号与密码后自动保存并连接</div>

      <div class="field">
        <label class="label">网盘根目录</label>
        <input v-model="form.rcloneRemotePath" class="input" placeholder="capturehub" />
      </div>

      <div class="field">
        <label class="label">rclone 模式</label>
        <div class="quality-picker" @click="rcloneModeOpen = true">
          <input
            class="input quality-input"
            :value="rcloneModeLabel(form.rcloneMode)"
            readonly
            placeholder="选择模式"
          />
          <span class="quality-arrow">▾</span>
        </div>
      </div>

      <div class="field">
        <label class="label">最大并发上传</label>
        <input v-model.number="form.maxConcurrentUploads" class="input" type="number" min="1" max="20" />
        <div class="muted">rclone 同时上传的最大任务数(1-20,默认 3)</div>
      </div>

      <div class="field">
        <label class="label">后处理脚本(sh)</label>
        <textarea v-model="form.postProcessScript" class="textarea" spellcheck="false" />
        <div class="muted" style="margin-top:6px">
          env: <code>CAPTUREHUB_FILE_PATH</code> <code>CAPTUREHUB_STREAMER</code> <code>CAPTUREHUB_RCLONE_MODE</code> ...
        </div>
      </div>
    </div>

    <!-- 4. 任务记录 -->
    <div class="card" style="margin-top:12px">
      <div class="row space wrap" style="margin-bottom:10px">
        <div class="row" style="gap:8px;align-items:center">
          <div class="item-title">任务记录</div>
          <span class="muted">{{ jobs.length }} 条</span>
        </div>
        <button class="btn btn-sm btn-danger" :disabled="clearing || !jobs.length" @click="clearAllJobs">
          {{ clearing ? '清除中...' : '清除记录' }}
        </button>
      </div>
      <div v-if="!jobs.length" class="empty">暂无后处理任务</div>
      <div v-else class="list">
        <div v-for="j in jobs" :key="j.id" class="card" style="box-shadow:none">
          <div class="row space wrap">
            <div class="item-title" style="font-size:14px">{{ j.filename }}</div>
            <span class="badge" :class="j.status">{{ STATUS_LABELS[j.status] || j.status }}</span>
          </div>
          <div class="item-sub">
            👤 {{ j.streamerName }}
            <span v-if="j.uploadTool" class="job-tool-badge">{{ j.uploadTool }} · {{ j.uploadMode || 'move' }}</span>
            · {{ TRIGGER_LABELS[j.trigger] || j.trigger }} · 🕒 {{ formatTime(j.createdAt) }}
          </div>
          <div class="actions">
            <button class="btn btn-sm" @click="logJob = j">日志</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 5. 日志弹窗(圆角适配全局按钮样式 10px / --radius-sm,参考"保存配置"按钮) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="logJob" class="modal-mask" @click.self="logJob = null">
          <div class="modal log-modal">
            <div class="modal-head">
              <h3>任务日志</h3>
              <button class="icon-btn" @click="logJob = null">✕</button>
            </div>
            <div class="item-sub" style="margin-bottom:8px">{{ logJob.filename }} · {{ STATUS_LABELS[logJob.status] }}</div>
            <pre class="log-pre">{{ logJob.log || '(空)' }}</pre>
            <div class="actions" style="margin-top:12px">
              <button class="btn btn-sm btn-primary" @click="copyLog">复制日志</button>
              <button class="btn btn-sm" @click="logJob = null">关闭</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 上传器选择弹窗(居中弹出) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="uploaderOpen" class="modal-mask" @click.self="uploaderOpen = false">
          <div class="modal">
            <div class="modal-head">
              <h3>上传器</h3>
              <button class="icon-btn" @click="uploaderOpen = false">✕</button>
            </div>
            <div class="quality-options">
              <button
                v-for="o in UPLOADER_OPTIONS"
                :key="o.value"
                class="quality-opt"
                :class="{ active: form.uploadTool === o.value }"
                @click="pickUploader(o.value)"
              >{{ o.label }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- grammY 模式选择弹窗(居中弹出) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="grammyModeOpen" class="modal-mask" @click.self="grammyModeOpen = false">
          <div class="modal">
            <div class="modal-head">
              <h3>grammY 模式</h3>
              <button class="icon-btn" @click="grammyModeOpen = false">✕</button>
            </div>
            <div class="quality-options">
              <button
                v-for="o in GRAMMY_MODE_OPTIONS"
                :key="o.value"
                class="quality-opt"
                :class="{ active: form.grammyMode === o.value }"
                @click="pickGrammyMode(o.value)"
              >{{ o.label }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- rclone 模式选择弹窗(居中弹出) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="rcloneModeOpen" class="modal-mask" @click.self="rcloneModeOpen = false">
          <div class="modal">
            <div class="modal-head">
              <h3>rclone 模式</h3>
              <button class="icon-btn" @click="rcloneModeOpen = false">✕</button>
            </div>
            <div class="quality-options">
              <button
                v-for="o in RCLONE_MODE_OPTIONS"
                :key="o.value"
                class="quality-opt"
                :class="{ active: form.rcloneMode === o.value }"
                @click="pickRcloneMode(o.value)"
              >{{ o.label }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
    <!-- 网盘类型选择弹窗(仅显示支持账号密码登录的网盘) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="rcloneProviderOpen" class="modal-mask" @click.self="rcloneProviderOpen = false">
          <div class="modal">
            <div class="modal-head">
              <h3>网盘类型</h3>
              <button class="icon-btn" @click="rcloneProviderOpen = false">✕</button>
            </div>
            <div v-if="!rcloneStatus?.providers.length" class="muted">加载中...</div>
            <div v-else class="quality-options">
              <button
                v-for="o in rcloneStatus.providers"
                :key="o.id"
                class="quality-opt"
                :class="{ active: form.rcloneProvider === o.id }"
                @click="pickRcloneProvider(o.id)"
              >{{ o.label }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.bot-server-box {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--surface-2);
}
/* Bot Server 状态徽章配色(限定在 .bot-server-box 内,避免影响任务记录徽章) */
.bot-server-box .badge.running::before { background: var(--ok); }
.bot-server-box .badge.stopped::before { background: var(--muted-foreground); }
.bot-server-box .badge.starting::before { background: var(--warn); }
.bot-server-box .badge.error::before { background: var(--destructive); }
.err-text { color: var(--destructive); }
/* ---- rclone 连接状态框(与 grammY 的 Bot Server 状态框样式一致) ---- */
.rclone-status-box {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--surface-2);
}
.rclone-status-box .badge.ok::before { background: var(--ok); }
.rclone-status-box .badge.err::before { background: var(--destructive); }
/* ---- 任务日志弹窗:圆角适配 StripchatRecorder-MobileUI(18px),与全局弹窗一致 ---- */
.log-modal {
  border-radius: 18px;
}
/* 日志内容区圆角略小于弹窗,形成协调的内外层次 */
.log-modal .log-pre {
  border-radius: var(--radius-md);
}
/* 日志卡片:上传工具与模式徽章(显示在时间前方) */
.job-tool-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: var(--radius-sm);
  margin: 0 2px;
  background: color-mix(in oklch, var(--info) 15%, transparent);
  color: var(--info);
  border: 1px solid color-mix(in oklch, var(--info) 25%, transparent);
  white-space: nowrap;
  vertical-align: middle;
}

/* ---- 上传器选择器(适配全局样式,与设置/主播页录制清晰度选择器一致) ---- */
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
</style>
