/**
 * useGameSeats — 房內遊戲座位（3–5 人房：2 人對戰、其餘觀戰）
 *
 * 座 0 恆房主；座 1 為想玩的非房主中最早 claim 者（純函數 seats.ts 決定，收斂）。
 * claim/release 經 mesh 'seat' 通道廣播；新進者送 SEAT_SYNC_REQ，想玩者重播 CLAIM 補齊。
 * 2 人房：非房主自動入座（保留既有「開遊戲即對戰」體驗，不需手動入座）。
 */
import type { Ref } from 'vue'
import type { GameBus } from '~/lib/gameBus'
import type { P2PEnvelope } from '@legacy/types'
import { generateUUID } from '@legacy/utils/uuid'
import { seatRole, seat1Holder, type SeatClaims, type SeatRole } from '@legacy/features/game/seats'

const SEAT_NS = 'seat'

export function useGameSeats(
  bus: Ref<GameBus | null>,
  selfId: Ref<string>,
  ownerId: Ref<string>,
  isOwner: Ref<boolean>,
  memberCount: Ref<number>
) {
  const wanting = ref<SeatClaims>({})
  const role = computed<SeatRole>(() => seatRole(wanting.value, ownerId.value, selfId.value))
  const seat1Taken = computed(() => seat1Holder(wanting.value, ownerId.value) !== null)
  const canSit = computed(() => role.value === 'spectator' && !seat1Taken.value)

  function send(type: string, payload: unknown) {
    const b = bus.value
    if (!b) return
    void b.send({
      v: 1, ns: SEAT_NS, type, id: generateUUID(), ts: Date.now(), from: selfId.value, payload: payload ?? {},
    } as P2PEnvelope).catch(() => undefined)
  }

  function claimSeat(broadcast = true) {
    if (isOwner.value) return // 房主恆座 0
    const ts = Date.now()
    wanting.value = { ...wanting.value, [selfId.value]: ts } // 樂觀
    // 只有 3+ 人房需要上線協商座位；2 人房角色是確定的（房主=first、對方=second），純本地即可，
    // 不送任何 seat gossip——避免與聊天共用同一 sender seq、放大 reserveSeq 降級造成掉訊。
    if (broadcast) send('CLAIM', { player: selfId.value, ts })
  }
  function releaseSeat() {
    const { [selfId.value]: _drop, ...rest } = wanting.value
    void _drop
    wanting.value = rest
    send('RELEASE', { player: selfId.value })
  }

  function ingestClaim(player: string, ts: number) {
    const cur = wanting.value[player]
    if (cur === undefined || ts < cur) wanting.value = { ...wanting.value, [player]: ts } // 保留最早
  }

  let unsub: (() => void) | null = null
  watch(
    bus,
    (b) => {
      unsub?.()
      unsub = null
      if (!b) return
      unsub = b.subscribe(SEAT_NS, (env) => {
        if (env.from === selfId.value) return
        const p = (env.payload ?? {}) as { player?: string; ts?: number }
        if (env.type === 'CLAIM' && typeof p.player === 'string' && typeof p.ts === 'number') {
          ingestClaim(p.player, p.ts)
        } else if (env.type === 'RELEASE' && typeof p.player === 'string') {
          const { [p.player]: _d, ...rest } = wanting.value
          void _d
          wanting.value = rest
        } else if (env.type === 'SYNC_REQ') {
          // 想玩者重播自己的 claim，讓新進者補齊集合（僅 3+ 房才有 gossip）
          const myTs = wanting.value[selfId.value]
          if (myTs !== undefined) send('CLAIM', { player: selfId.value, ts: myTs })
        }
      })
    },
    { immediate: true }
  )

  // 座位協商只在 3+ 人房上線：2 人房角色確定（房主=first、對方=second）→ 純本地，零 seat gossip
  // （避免與聊天共用 seq、放大 reserveSeq 降級而掉訊）。跨過 2→3 時把本地入座升級成廣播 + 問座位。
  let announced3p = false
  watch(
    [bus, memberCount],
    () => {
      const b = bus.value
      if (!b || isOwner.value) return
      const count = memberCount.value
      if (count === 2 && !seat1Taken.value) {
        claimSeat(false) // 2 人房自動入座、純本地
      } else if (count > 2 && !announced3p) {
        announced3p = true
        const myTs = wanting.value[selfId.value]
        if (myTs !== undefined) send('CLAIM', { player: selfId.value, ts: myTs }) // 升級本地入座為廣播
        send('SYNC_REQ', {}) // 問現有座位
      }
    },
    { immediate: true }
  )

  onUnmounted(() => unsub?.())

  return { role, canSit, seat1Taken, claimSeat, releaseSeat }
}
