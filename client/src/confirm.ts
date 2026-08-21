import { ref } from 'vue';

/**
 * 全局确认弹窗服务
 * 替代浏览器原生 window.confirm(原生弹窗无法修改样式、且移动端会显示地址/IP)
 *
 * 用法:
 *   const { confirm } = useConfirm();
 *   if (await confirm({ title: '删除主播', message: '确认删除「xxx」?', danger: true })) {
 *     // 用户点击了确认
 *   }
 */
export interface ConfirmOptions {
  /** 标题(默认:请确认) */
  title?: string;
  /** 正文消息 */
  message: string;
  /** 确认按钮文字(默认:确认) */
  confirmText?: string;
  /** 取消按钮文字(默认:取消) */
  cancelText?: string;
  /** 危险操作(按钮变红,默认 false) */
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (v: boolean) => void;
}

/** 当前活动的确认请求(同时只允许一个,新的会顶掉旧的) */
const current = ref<ConfirmRequest | null>(null);
let seq = 0;

function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 若已有弹窗,先以“取消”收尾旧的,避免 Promise 悬挂
    if (current.value) {
      current.value.resolve(false);
    }
    current.value = { id: ++seq, ...options, resolve };
  });
}

/** 关闭弹窗并返回结果(供组件与外部调用) */
function settle(result: boolean) {
  const req = current.value;
  current.value = null;
  req?.resolve(result);
}

function dismiss() {
  settle(false);
}

export function useConfirm() {
  return {
    current,
    confirm,
    settle,
    dismiss,
  };
}
