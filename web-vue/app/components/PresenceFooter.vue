<script setup lang="ts">
/**
 * 在線節點數頁尾（盲信使可見前哨；ADR-0023 P4-A.2）。
 * Spec 006 收斂時 UI 掛鉤被砍、presence 機制照跑；2026-07-18 拍板以輕量頁尾補回。
 * 自帶 useNodePresence 生命週期（mount 宣告、unmount 撤宣告）——單一實例掛在
 * dashboard，勿在同頁重複掛載（會重複 announce）。
 * 誠實條款：只在真宣告成功（非匿名、rules 放行）且有同伴時顯示，不做假在線。
 */
const props = defineProps<{ uid: string }>()

const { peerCount, announcing, start, stop } = useNodePresence()
onMounted(() => { void start(props.uid) })
onUnmounted(() => { void stop() })
</script>

<template>
  <p v-if="announcing && peerCount > 0" class="presence-footer">
    🛡 還有 <span data-testid="online-node-count">{{ peerCount }}</span> 個節點一起守護
  </p>
</template>

<style scoped>
.presence-footer {
  margin-top: 14px;
  text-align: center;
  font-size: 0.78rem;
  color: var(--text-dim, var(--text-secondary, #888));
  opacity: 0.85;
}
</style>
