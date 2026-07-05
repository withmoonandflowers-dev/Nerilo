<script setup lang="ts">
const { user, loading, loginWithGoogle, loginWithEmail, registerWithEmail } = useAuth()
const { error: toastError } = useToast()

const email = ref('')
const password = ref('')
const showEmail = ref(false)
const isRegister = ref(false)
const busy = ref(false)

watchEffect(() => {
  if (!loading.value && user.value && !user.value.isAnonymous) {
    navigateTo('/dashboard', { replace: true })
  }
})

async function handleGoogle() {
  busy.value = true
  try {
    await loginWithGoogle()
  } catch {
    toastError('Google 登入失敗，請再試一次')
  } finally {
    busy.value = false
  }
}

async function handleEmail() {
  if (!email.value || !password.value) return
  busy.value = true
  try {
    if (isRegister.value) await registerWithEmail(email.value, password.value)
    else await loginWithEmail(email.value, password.value)
    navigateTo('/dashboard', { replace: true })
  } catch {
    toastError(isRegister.value ? '註冊失敗，請確認資料' : '登入失敗，請確認帳號密碼')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="login">
    <div class="login__card card">
      <div class="login__logo">💬</div>
      <h1 class="login__title">Nerilo</h1>
      <p class="login__subtitle">點對點加密聊天，訊息不經過伺服器</p>

      <button type="button" class="btn-secondary login__google" :disabled="busy" @click="handleGoogle">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
          <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41.4 34.9 44 30 44 24c0-1.3-.1-2.6-.4-3.9z"/>
        </svg>
        使用 Google 繼續
      </button>

      <button v-if="!showEmail" type="button" class="login__email-toggle" @click="showEmail = true">
        使用 Email 登入
      </button>

      <Transition name="expand">
        <form v-if="showEmail" class="login__form" @submit.prevent="handleEmail">
          <input v-model="email" class="field" type="email" placeholder="Email" autocomplete="email" />
          <input v-model="password" class="field" type="password" placeholder="密碼"
                 :autocomplete="isRegister ? 'new-password' : 'current-password'" />
          <button type="submit" class="btn-primary" :disabled="busy || !email || !password">
            {{ busy ? '處理中…' : isRegister ? '註冊' : '登入' }}
          </button>
          <button type="button" class="login__email-toggle" @click="isRegister = !isRegister">
            {{ isRegister ? '已有帳號？登入' : '沒有帳號？註冊' }}
          </button>
        </form>
      </Transition>

      <NuxtLink to="/dashboard" class="login__guest">先以訪客身份逛逛</NuxtLink>
    </div>
  </main>
</template>

<style scoped>
.login {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.login__card {
  width: min(400px, 100%);
  padding: 40px 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.login__logo {
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 36px;
  background: linear-gradient(135deg, #0A84FF, #64B5FF);
  border-radius: 22px;
  box-shadow: var(--shadow-2);
}
.login__title {
  margin: 8px 0 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.4px;
}
.login__subtitle {
  margin: 0 0 16px;
  font-size: 15px;
  color: var(--text-2);
  text-align: center;
}
.login__google { width: 100%; }
.login__email-toggle {
  padding: 8px;
  font-size: 15px;
  color: var(--primary);
  font-weight: 500;
}
.login__form {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.login__guest {
  margin-top: 8px;
  font-size: 14px;
  color: var(--text-2);
  text-decoration: none;
}
.expand-enter-active { transition: all var(--t-mid) var(--spring); }
.expand-enter-from { opacity: 0; transform: translateY(-8px); }
</style>
