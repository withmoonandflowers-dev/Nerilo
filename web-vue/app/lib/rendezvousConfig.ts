/** Spec 030 Q3：HTTP rendezvous 位址的來源選擇與瀏覽器端保存。 */
const INVITE_KEY_PREFIX = 'nerilo:rendezvous:invite:'
const USER_KEY = 'nerilo:rendezvous:user'

export interface RendezvousUrlSources {
  invite?: string | null
  user?: string | null
  deployment?: string | null
}

export function normalizeRendezvousUrl(value: string | null | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw || raw.length > 2048) return undefined
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return undefined
    }
    url.hash = ''
    url.search = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

/** 固定優先序：邀請資料、使用者輸入、部署設定。 */
export function selectRendezvousUrl(sources: RendezvousUrlSources): string | undefined {
  return normalizeRendezvousUrl(sources.invite)
    ?? normalizeRendezvousUrl(sources.user)
    ?? normalizeRendezvousUrl(sources.deployment)
}

export function rememberInviteRendezvousUrl(roomId: string, value: string): void {
  const normalized = normalizeRendezvousUrl(value)
  if (!normalized || typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(`${INVITE_KEY_PREFIX}${roomId}`, normalized)
}

export function saveUserRendezvousUrl(value: string | undefined): void {
  if (typeof localStorage === 'undefined') return
  const normalized = normalizeRendezvousUrl(value)
  if (normalized) localStorage.setItem(USER_KEY, normalized)
  else localStorage.removeItem(USER_KEY)
}

export function readUserRendezvousUrl(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return normalizeRendezvousUrl(localStorage.getItem(USER_KEY))
}

export function resolveRendezvousUrl(roomId: string, deployment?: string): string | undefined {
  const invite = typeof sessionStorage === 'undefined'
    ? undefined
    : sessionStorage.getItem(`${INVITE_KEY_PREFIX}${roomId}`)
  return selectRendezvousUrl({ invite, user: readUserRendezvousUrl(), deployment })
}
