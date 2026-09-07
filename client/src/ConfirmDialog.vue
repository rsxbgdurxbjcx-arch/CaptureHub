<script setup lang="ts">
import { useConfirm } from './confirm';

const { current, settle, dismiss } = useConfirm();
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="current" class="confirm-mask" @click.self="dismiss">
        <div class="confirm-dialog" role="dialog" aria-modal="true">
          <div class="confirm-head">
            <span class="confirm-title">{{ current.title || '请确认' }}</span>
            <button class="confirm-close" aria-label="关闭" @click="dismiss">✕</button>
          </div>
          <div class="confirm-body">{{ current.message }}</div>
          <div class="confirm-actions">
            <button class="btn confirm-btn" @click="dismiss">
              {{ current.cancelText || '取消' }}
            </button>
            <button
              class="btn confirm-btn"
              :class="current.danger ? 'btn-danger' : 'btn-primary'"
              @click="settle(true)"
            >
              {{ current.confirmText || '确认' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-mask {
  position: fixed;
  inset: 0;
  background: oklch(0.1 0.02 25 / 45%);
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 20px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.confirm-dialog {
  width: min(88vw, 360px);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 20px;
  box-shadow:
    0 4px 12px -4px oklch(0 0 0 / 15%),
    0 24px 64px -16px oklch(0 0 0 / 35%);
  animation: confirmIn 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}
.confirm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.confirm-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--foreground);
}
.confirm-close {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 13px;
  cursor: pointer;
  display: grid;
  place-items: center;
  opacity: 0.7;
  transition: background 0.15s, color 0.15s, opacity 0.15s;
}
.confirm-close:hover {
  background: var(--accent);
  color: var(--foreground);
  opacity: 1;
}
.confirm-body {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--foreground-soft, var(--foreground));
  word-break: break-word;
  margin-bottom: 16px;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.confirm-btn {
  min-width: 72px;
}
@keyframes confirmIn {
  from { transform: translateY(12px) scale(0.96); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
</style>
