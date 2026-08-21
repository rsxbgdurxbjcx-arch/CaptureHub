import { onBeforeUnmount, watch } from 'vue';
import type { Ref } from 'vue';

/**
 * 统一自动保存机制(后处理/设置等配置页面共用,页面不写各套逻辑):
 * - 深度监听表单:输入、开关、弹窗选择 → 防抖自动保存(默认 700ms)
 * - 输入框失焦(点击空白处)、回车、切换输入焦点 → 立即保存
 * - 页面卸载/切后台 → 保底保存(keepalive 请求,尽力而为)
 * - 保存串行化:请求在途时合并为一次后续保存,避免乱序覆盖
 * - 加载完成前的表单赋值不会触发保存;内容无变化时不重复请求
 * - 保存失败调用 onError 给出明确错误提示
 */

export interface AutoSaveOptions<T> {
  /** 表单对象(整体提交,提交内容与旧"保存"按钮完全一致) */
  form: Ref<T>;
  /** 是否已完成初始加载(加载完成前不触发保存,防止初始赋值误触发) */
  ready: Ref<boolean>;
  /** 执行保存(整体提交);失败时抛错 */
  save: (payload: T) => Promise<void>;
  /** 页面卸载/切后台时的保底保存(fetch keepalive,尽力而为) */
  keepalive?: (payload: T) => void;
  /** 防抖延迟 ms,默认 700 */
  debounceMs?: number;
  /** 保存前校验:返回错误消息则中止保存并提示 */
  validate?: (payload: T) => string | null;
  /** 保存成功回调(默认静默) */
  onSuccess?: () => void;
  /** 保存失败/校验失败回调(错误提示) */
  onError?: (msg: string) => void;
}

export function useAutoSave<T>(opts: AutoSaveOptions<T>) {
  const {
    form,
    ready,
    save,
    keepalive,
    debounceMs = 700,
    validate,
    onSuccess,
    onError,
  } = opts;

  let timer: number | undefined;
  let inFlight = false;
  let dirty = false;
  let rerun = false;
  /** 上次成功提交的 JSON 快照:内容无变化时跳过请求 */
  let lastSavedJson: string | null = null;

  const snapshot = (): T => JSON.parse(JSON.stringify(form.value)) as T;

  async function doSave() {
    if (!ready.value) return;
    if (inFlight) {
      // 请求在途:标记需要补存,完成后用最新内容再存一次
      rerun = true;
      return;
    }
    const payload = snapshot();
    const json = JSON.stringify(payload);
    if (json === lastSavedJson) {
      dirty = false;
      return;
    }
    if (validate) {
      const msg = validate(payload);
      if (msg) {
        onError?.(msg);
        dirty = false;
        return;
      }
    }
    inFlight = true;
    try {
      await save(payload);
      lastSavedJson = json;
      dirty = false;
      onSuccess?.();
    } catch (e) {
      // 保存失败:保留脏标记,后续输入/失焦会重试
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight = false;
      if (rerun) {
        rerun = false;
        void doSave();
      }
    }
  }

  /** 防抖调度:输入过程中持续重置计时器 */
  function schedule() {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void doSave();
    }, debounceMs);
  }

  /** 立即保存(失焦/回车/卸载):跳过防抖等待 */
  function flush() {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty) return;
    void doSave();
  }

  // 深度监听表单:任何输入/开关/弹窗选择 → 防抖保存
  watch(
    form,
    () => {
      if (!ready.value) return;
      dirty = true;
      schedule();
    },
    { deep: true },
  );

  // 初始加载完成时记录基准快照:加载赋值不会触发无意义的保存
  watch(ready, (val, old) => {
    if (val && !old) {
      lastSavedJson = JSON.stringify(snapshot());
      dirty = false;
    }
  });

  // 失焦(点击空白处/切换输入焦点)→ 立即保存;focusout 会冒泡,统一在 document 捕获
  const onFocusOut = (e: FocusEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      flush();
    }
  };
  // 回车 → 立即保存(文本域中回车表示换行,不拦截)
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) {
      flush();
    }
  };

  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('keydown', onKeydown, true);

  // 页面卸载/切后台:保底保存(keepalive 尽力而为 + 常规保存)
  const onPageHide = () => {
    if (!ready.value || !dirty) return;
    try {
      keepalive?.(snapshot());
    } catch {
      // ignore:保底保存失败不影响主流程
    }
    flush();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') onPageHide();
  };

  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);

  onBeforeUnmount(() => {
    if (timer !== undefined) window.clearTimeout(timer);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    onPageHide();
  });

  return { flush, schedule };
}
