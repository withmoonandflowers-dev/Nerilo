/**
 * 適應度：死重圍籬「真的會擋」的探針（ADR-0031 修訂二，2026-07-26）。
 *
 * 為什麼需要這支：圍籬自 2026-07-16 立起，大家都相信它在擋 PARK 模組。實測發現
 * `no-restricted-imports` 比對的是**import 字串**而不是解析後的路徑，所以
 * 「星號星號斜線 core/game」形式只擋得住 `@/core/game/X`，擋不住 `../game/X`——
 * 而 docs/DEVELOPMENT.md 的慣例正是「core 模組用相對路徑」。圍籬在它最該生效的
 * core→core 方向上一直是裝飾品，而且沒有任何測試會發現。
 *
 * 這支測試直接對 ESLint 設定做斷言：每個 PARK 模組都必須同時有別名形式與相對形式的
 * pattern。它擋的不是「有沒有人違規」，是「圍籬本身有沒有效」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const config = readFileSync(join(ROOT, '.eslintrc.cjs'), 'utf8');

/** 目前 PARK 的模組（與 ADR-0031 名單同步）。 */
const PARKED = [
  { name: 'community', alias: '**/core/community/**', rel: '../community/**' },
  { name: 'game', alias: '**/core/game/**', rel: '../game/**' },
  { name: 'transport', alias: '**/core/transport/**', rel: '../transport/**' },
  { name: 'ledger', alias: '**/core/ledger/**', rel: '../ledger/**' },
  { name: 'features', alias: '**/core/features/**', rel: '../features/**' },
  { name: 'relay/onion', alias: '**/core/relay/onion/**', rel: '../relay/onion/**' },
];

describe('死重圍籬適應度（ADR-0031）', () => {
  it.each(PARKED)('$name 有別名形式的 pattern', ({ alias }) => {
    expect(config).toContain(`'${alias}'`);
  });

  it.each(PARKED)('$name 有相對形式的 pattern（沒有＝core→core 擋不住）', ({ rel }) => {
    expect(config).toContain(`'${rel}'`);
  });

  it('相對形式只出現在 core/services 區塊（features 底下 ../game 是活的 UI 薄層）', () => {
    // `../game/**` 若被複製到 features 區塊，會誤擋 ChatPage → features/game/TicTacToePanel
    // （ADR-0015 的活元件）。實測踩過，故釘住只出現一次。
    const occurrences = config.split("'../game/**'").length - 1;
    expect(occurrences).toBe(1);
  });

  it('PARK 模組自身列在 excludedFiles（否則內部互相 import 會被自己擋）', () => {
    for (const { name } of PARKED) {
      expect(config).toContain(`'src/core/${name}/**'`);
    }
  });
});
