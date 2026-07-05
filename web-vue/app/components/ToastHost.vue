<script setup lang="ts">
const { toasts } = useToast()

const icons: Record<string, string> = {
  success: '✓',
  error: '!',
  warning: '!',
  info: 'i',
}
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="`toast--${t.type}`">
        <span class="toast__icon">{{ icons[t.type] }}</span>
        <span class="toast__msg">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  z-index: 1000;
}
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(420px, calc(100vw - 32px));
  padding: 12px 18px;
  background: var(--surface);
  border-radius: var(--r-pill);
  box-shadow: var(--shadow-2);
  font-size: 15px;
  font-weight: 500;
}
.toast__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
}
.toast--success .toast__icon { background: var(--success); }
.toast--error .toast__icon { background: var(--danger); }
.toast--warning .toast__icon { background: var(--warning); }
.toast--info .toast__icon { background: var(--primary); }

.toast-enter-active { transition: all var(--t-mid) var(--spring); }
.toast-leave-active { transition: all var(--t-fast) var(--ease); }
.toast-enter-from { opacity: 0; transform: translateY(-16px) scale(0.9); }
.toast-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
