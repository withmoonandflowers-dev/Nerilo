/**
 * 架構適應度函數（架構收斂稽核 §6 / ADR-0031 配套）
 *
 * 把「收斂決策」寫成會紅的測試，防止慢慢爛回去：
 *  1. god-file 行數棘輪：四個既有大檔以現值為上限、只准變小；產品層不得出現新的 >800 行檔。
 *  2. SDK 公開表面快照：`nerilo` 與 `nerilo/firestore` 的匯出名單被改動＝破壞性變更候選，
 *     必須顯性更新本快照（等於強制 review），防止內部型別悄悄外洩到公開 API。
 *
 * 棘輪更新規則：檔案變小後，把 baseline 調低到新值（只降不升）；要放寬上限＝改架構決策，
 * 請先更新 docs/audit/architecture-convergence-2026-07.md 的裁決再動這裡。
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');

// ── 1. god-file 行數棘輪 ────────────────────────────────────────────────────

/** 既有大檔的祖父條款上限（2026-07-16 實測，計法=split('\n').length，較 wc -l 多 1）。只准調低。 */
const GOD_FILE_BASELINE: Record<string, number> = {
  'src/features/chat/ChatPage.tsx': 1204,
  // 1172→1168（2026-07-17 Spec 006：主題循環鈕移除＋遊戲旗標抽 lib/gameRoomFlag，反向調低）
  'web-vue/app/pages/chat/[roomId].vue': 1168,
  // 1055→988（2026-07-16）：updateMeshIdentity 抽至 meshIdentityRegistry.ts（棘輪反向調低）
  'src/services/RoomService.ts': 988,
  // 862→795（2026-07-17 Spec 006：砍中繼卡＋P2P 目錄＋主題鈕，反向調低）
  'web-vue/app/pages/dashboard.vue': 795,
};

/** 名單外產品檔的行數上限。超過＝長出新 god-file，先拆再合。 */
const NEW_FILE_LIMIT = 800;

const PRODUCT_DIRS = ['src', 'web-vue/app'];
const PRODUCT_EXT = /\.(ts|tsx|vue)$/;
const EXCLUDE = /node_modules|\.spec\.|\.test\.|\/tests\//;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (EXCLUDE.test(p)) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (PRODUCT_EXT.test(name)) out.push(p);
  }
  return out;
}

const lineCount = (p: string) => readFileSync(p, 'utf8').split('\n').length;

describe('適應度：god-file 行數棘輪', () => {
  it('祖父名單內的大檔不得超過基線（只准變小）', () => {
    const grew: string[] = [];
    for (const [rel, baseline] of Object.entries(GOD_FILE_BASELINE)) {
      const lines = lineCount(join(ROOT, rel));
      if (lines > baseline) grew.push(`${rel}: ${lines} > 基線 ${baseline}`);
    }
    expect(grew, `god-file 變大了（棘輪只准變小；要加功能請先拆檔）：\n${grew.join('\n')}`).toEqual([]);
  });

  it(`名單外的產品檔不得超過 ${NEW_FILE_LIMIT} 行（不長新 god-file）`, () => {
    const offenders: string[] = [];
    for (const dir of PRODUCT_DIRS) {
      for (const p of walk(join(ROOT, dir))) {
        const rel = p.slice(ROOT.length + 1);
        if (rel in GOD_FILE_BASELINE) continue; // 祖父條款
        const lines = lineCount(p);
        if (lines > NEW_FILE_LIMIT) offenders.push(`${rel}: ${lines} 行`);
      }
    }
    expect(offenders, `長出新的 >${NEW_FILE_LIMIT} 行檔（請拆分，或經架構裁決加入祖父名單）：\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ── 2. SDK 公開表面快照 ─────────────────────────────────────────────────────

/** 從進入點原始碼抽出匯出名（value 與 type 都算公開契約）。 */
function exportedNames(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const names = new Set<string>();
  // export { A, B } / export type { C } （含 re-export）
  for (const m of src.matchAll(/^export (?:type )?\{([^}]+)\}/gm)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()!.trim();
      if (name) names.add(name);
    }
  }
  // export (async) function/class/const/interface/type X
  for (const m of src.matchAll(/^export (?:async )?(?:function|class|const|interface|type)\s+([A-Za-z0-9_]+)/gm)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

describe('適應度：SDK 公開表面快照（動它＝改公開契約，需顯性 review）', () => {
  it('nerilo（主入口）匯出名單', () => {
    expect(exportedNames('src/sdk/index.ts')).toEqual([
      'ChatMessage',
      'DirectoryIdentity',
      'HLCTimestamp',
      'IChatEngine',
      'IChatStorage',
      'IRoomDirectory',
      'IRoomService',
      'InMemoryChatStorage',
      'InMemoryRoomDirectory',
      'InMemoryRoomDirectoryHub',
      'InMemorySignalingHub',
      'InMemorySignalingTransport',
      'NeriloClient',
      'Positioned',
      'RawSignalDoc',
      'ReactionEvent',
      'ReactionMap',
      'ReactionOp',
      'ReadEvent',
      'ReadState',
      'RoomSnapshot',
      'SignalingFactory',
      'SignalingTransport',
      'applyReaction',
      'applyRead',
      'decodeContent',
      'encodeContent',
      'hasReacted',
      'orderKeyOf',
      'readCount',
      'readersOf',
    ]);
  });

  it('nerilo/firestore（turnkey 工廠）匯出名單', () => {
    expect(exportedNames('src/sdk/firestore.ts')).toEqual([
      'createChatClient',
      'createFirestoreChatClient',
    ]);
  });
});
