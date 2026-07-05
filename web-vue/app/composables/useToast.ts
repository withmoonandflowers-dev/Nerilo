/** Toast composable — 對應 React 版 ToastContext（最多 5 則、3–5 秒自動消失） */
import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: number
  message: string
  type: ToastType
}

const toasts = ref<ToastItem[]>([])
let nextId = 1

function push(message: string, type: ToastType = 'info') {
  const id = nextId++
  toasts.value = [...toasts.value.slice(-4), { id, message, type }]
  const ttl = type === 'error' ? 5000 : 3000
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, ttl)
}

export function useToast() {
  return {
    toasts,
    toast: push,
    success: (m: string) => push(m, 'success'),
    error: (m: string) => push(m, 'error'),
    warning: (m: string) => push(m, 'warning'),
    info: (m: string) => push(m, 'info'),
  }
}
