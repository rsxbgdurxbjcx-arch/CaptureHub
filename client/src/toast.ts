import { ref } from 'vue';

export interface ToastItem {
  id: number;
  text: string;
  type: 'info' | 'success' | 'warn' | 'error';
}

const list = ref<ToastItem[]>([]);
let seq = 0;

function show(text: string, type: ToastItem['type'] = 'info', timeout = 2400) {
  const id = ++seq;
  list.value.push({ id, text, type });
  if (timeout > 0) setTimeout(() => dismiss(id), timeout);
  return id;
}

function dismiss(id: number) {
  const idx = list.value.findIndex((t) => t.id === id);
  if (idx >= 0) list.value.splice(idx, 1);
}

export function useToast() {
  return {
    list,
    show,
    info: (t: string) => show(t, 'info'),
    success: (t: string) => show(t, 'success'),
    warn: (t: string) => show(t, 'warn'),
    error: (t: string) => show(t, 'error', 3800),
    dismiss,
  };
}
