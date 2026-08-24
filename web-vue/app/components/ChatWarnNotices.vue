<script setup lang="ts">
/**
 * 聊天頁常駐警示橫幅（自 [roomId].vue 抽出；Spec 022 T6 順帶棘輪反向縮頁）。
 * data-testid 與文案原樣保留——E2E 斷言依賴它們，抽取不得改變 DOM 可測面。
 */
defineProps<{
  otherTabActive: boolean
  protocolMismatch: boolean
  plaintextNotice: boolean
  keyConflict: boolean
  keyConflictLimitReached: boolean
}>()
</script>

<template>
  <!-- B1：同房只允許一個分頁參與 mesh（兩頁共用同一組 mesh 身分，同時參與會掉訊息）。 -->
  <div v-if="otherTabActive" class="chat__e2ee-warn" data-testid="other-tab-notice">
    ⚠️ 這個聊天室已在另一個分頁開啟。請回到那個分頁繼續，或關閉它後重新整理這頁。
  </div>

  <!-- Spec 009：gossip 協議版本不合的常駐提示（訊息無法互通，請雙方更新）。 -->
  <div v-if="protocolMismatch" class="chat__e2ee-warn" data-testid="protocol-mismatch-notice">
    ⚠️ 房內有版本不相容的成員，訊息無法互通。請雙方更新到最新版後重新整理。
  </div>

  <!-- ADR-0026 R2：明文降級的常駐提示（此房永久無法加密，讓使用者「知情」）。 -->
  <div v-if="plaintextNotice" class="chat__e2ee-warn" data-testid="plaintext-notice">
    ⚠️ 此聊天室無法端對端加密，訊息將以明文送出。
  </div>

  <!-- Spec 022：同代異鑰的誠實告知（金鑰不一致，部分訊息可能無法解讀）。 -->
  <div v-if="keyConflict" class="chat__e2ee-warn" data-testid="key-conflict-notice">
    ⚠️ 此房金鑰不一致，部分訊息可能無法解讀。{{ keyConflictLimitReached ? '自動換代已達上限，請全員重新整理。' : '系統正在換發新金鑰。' }}
  </div>
</template>
