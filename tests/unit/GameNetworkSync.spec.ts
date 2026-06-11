/**
 * Sprint 3 — Game Engine Phase 2-4 測試
 *
 * InputBuffer：輸入緩衝、預測、延遲補償
 * NetworkSyncManager：Lockstep 同步、回溯
 * GameStateValidator：狀態雜湊比對、作弊偵測
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InputBuffer } from '../../src/core/game/InputBuffer';
import { NetworkSyncManager } from '../../src/core/game/NetworkSyncManager';
import { GameStateValidator } from '../../src/core/game/GameStateValidator';
import { World } from '../../src/core/game/World';
import type { PlayerInput } from '../../src/core/game/types';

// ══════════════════════════════════════════════════════════════════════════════
// InputBuffer
// ══════════════════════════════════════════════════════════════════════════════

describe('InputBuffer — 基本操作', () => {
  let buf: InputBuffer;

  beforeEach(() => {
    buf = new InputBuffer({ bufferSize: 64, inputDelay: 2 });
  });

  it('註冊與移除玩家', () => {
    buf.addPeer('alice');
    buf.addPeer('bob');
    expect(buf.getPeerCount()).toBe(2);

    buf.removePeer('alice');
    expect(buf.getPeerCount()).toBe(1);
  });

  it('本機輸入自動加上 inputDelay', () => {
    buf.addPeer('alice');
    const input = buf.addLocalInput('alice', 10, ['jump']);

    // inputDelay=2 → 生效 tick = 10+2 = 12
    expect(input.tick).toBe(12);
    expect(input.actions).toEqual(['jump']);
    expect(buf.getInput(12, 'alice')).toBeTruthy();
    expect(buf.getInput(10, 'alice')).toBeUndefined(); // tick 10 沒有
  });

  it('遠端輸入直接存入，不加 delay', () => {
    buf.addPeer('bob');
    const remote: PlayerInput = {
      peerId: 'bob',
      tick: 15,
      actions: ['fire'],
      axes: { aim: 0.5 },
      seq: 1,
    };
    buf.addRemoteInput(remote);
    expect(buf.getInput(15, 'bob')?.actions).toEqual(['fire']);
  });

  it('同一個 tick+peer 的輸入，seq 大的覆蓋 seq 小的', () => {
    buf.addPeer('alice');
    buf.addRemoteInput({ peerId: 'alice', tick: 5, actions: ['old'], axes: {}, seq: 1 });
    buf.addRemoteInput({ peerId: 'alice', tick: 5, actions: ['new'], axes: {}, seq: 2 });
    expect(buf.getInput(5, 'alice')?.actions).toEqual(['new']);

    // seq 更小的不會覆蓋
    buf.addRemoteInput({ peerId: 'alice', tick: 5, actions: ['older'], axes: {}, seq: 0 });
    expect(buf.getInput(5, 'alice')?.actions).toEqual(['new']);
  });
});

describe('InputBuffer — tick 齊全判斷', () => {
  let buf: InputBuffer;

  beforeEach(() => {
    buf = new InputBuffer({ inputDelay: 0 });
    buf.addPeer('alice');
    buf.addPeer('bob');
  });

  it('兩位玩家的輸入都到齊時 isTickReady 回傳 true', () => {
    buf.addRemoteInput({ peerId: 'alice', tick: 1, actions: [], axes: {}, seq: 1 });
    expect(buf.isTickReady(1)).toBe(false);

    buf.addRemoteInput({ peerId: 'bob', tick: 1, actions: [], axes: {}, seq: 1 });
    expect(buf.isTickReady(1)).toBe(true);
  });

  it('getMissingPeers 回傳缺少輸入的玩家', () => {
    buf.addRemoteInput({ peerId: 'alice', tick: 1, actions: [], axes: {}, seq: 1 });
    expect(buf.getMissingPeers(1)).toEqual(['bob']);
  });

  it('沒有任何玩家時 isTickReady 回傳 true', () => {
    const emptyBuf = new InputBuffer();
    expect(emptyBuf.isTickReady(0)).toBe(true);
  });
});

describe('InputBuffer — 預測（prediction）', () => {
  let buf: InputBuffer;

  beforeEach(() => {
    buf = new InputBuffer({ inputDelay: 0, maxPredictionTicks: 5 });
    buf.addPeer('alice');
  });

  it('有確切輸入時直接回傳', () => {
    buf.addRemoteInput({ peerId: 'alice', tick: 3, actions: ['jump'], axes: {}, seq: 1 });
    const result = buf.getOrPredict(3, 'alice');
    expect(result.actions).toEqual(['jump']);
    expect(buf.isPredicted(result)).toBe(false);
  });

  it('缺少輸入時用前一個 tick 的輸入預測', () => {
    buf.addRemoteInput({ peerId: 'alice', tick: 3, actions: ['move'], axes: { x: 0.5 }, seq: 1 });

    // tick 4 沒有輸入 → 用 tick 3 的預測
    const predicted = buf.getOrPredict(4, 'alice');
    expect(predicted.actions).toEqual(['move']);
    expect(predicted.axes).toEqual({ x: 0.5 });
    expect(predicted.tick).toBe(4);
    expect(buf.isPredicted(predicted)).toBe(true);
  });

  it('完全沒有歷史時回傳空輸入', () => {
    const predicted = buf.getOrPredict(10, 'alice');
    expect(predicted.actions).toEqual([]);
    expect(predicted.axes).toEqual({});
    expect(buf.isPredicted(predicted)).toBe(true);
  });

  it('超過 maxPredictionTicks 範圍時用 lastKnownInput', () => {
    buf.addRemoteInput({ peerId: 'alice', tick: 1, actions: ['dash'], axes: {}, seq: 1 });

    // tick 100 → 距離 tick 1 遠超過 maxPredictionTicks(5)，但 lastKnownInput 仍有
    const predicted = buf.getOrPredict(100, 'alice');
    expect(predicted.actions).toEqual(['dash']);
  });
});

describe('InputBuffer — 歷史管理', () => {
  let buf: InputBuffer;

  beforeEach(() => {
    buf = new InputBuffer({ bufferSize: 10 });
    buf.addPeer('alice');
  });

  it('discardBefore 清除舊 tick', () => {
    for (let t = 0; t < 20; t++) {
      buf.addRemoteInput({ peerId: 'alice', tick: t, actions: [], axes: {}, seq: t });
    }
    buf.discardBefore(15);
    expect(buf.getInput(14, 'alice')).toBeUndefined();
    expect(buf.getInput(15, 'alice')).toBeTruthy();
  });

  it('bufferSize 超過上限時自動淘汰最舊的', () => {
    for (let t = 0; t < 20; t++) {
      buf.addRemoteInput({ peerId: 'alice', tick: t, actions: [], axes: {}, seq: t });
    }
    // bufferSize=10 → 只保留最新的 10 個 tick
    expect(buf.getBufferedTickCount()).toBe(10);
    expect(buf.getInput(0, 'alice')).toBeUndefined();
    expect(buf.getInput(19, 'alice')).toBeTruthy();
  });

  it('getOldestTick / getNewestTick', () => {
    buf.addRemoteInput({ peerId: 'alice', tick: 5, actions: [], axes: {}, seq: 1 });
    buf.addRemoteInput({ peerId: 'alice', tick: 10, actions: [], axes: {}, seq: 2 });
    buf.addRemoteInput({ peerId: 'alice', tick: 3, actions: [], axes: {}, seq: 3 });
    expect(buf.getOldestTick()).toBe(3);
    expect(buf.getNewestTick()).toBe(10);
  });

  it('clear / destroy', () => {
    buf.addRemoteInput({ peerId: 'alice', tick: 1, actions: [], axes: {}, seq: 1 });
    buf.clear();
    expect(buf.getBufferedTickCount()).toBe(0);
    expect(buf.getPeerCount()).toBe(1); // clear 不移除 peer

    buf.destroy();
    expect(buf.getPeerCount()).toBe(0); // destroy 移除 peer
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NetworkSyncManager
// ══════════════════════════════════════════════════════════════════════════════

describe('NetworkSyncManager — 基本推進', () => {
  let world: World;
  let inputBuf: InputBuffer;
  let sync: NetworkSyncManager;

  beforeEach(() => {
    world = new World();
    inputBuf = new InputBuffer({ inputDelay: 0 });
    sync = new NetworkSyncManager(world, inputBuf, {
      maxPredictionAhead: 5,
      maxSnapshots: 20,
      enableStateHash: true,
    });

    inputBuf.addPeer('alice');
    inputBuf.addPeer('bob');
  });

  it('輸入齊全時正常推進 tick', () => {
    // tick 0：兩人都有輸入
    inputBuf.addRemoteInput({ peerId: 'alice', tick: 0, actions: [], axes: {}, seq: 1 });
    inputBuf.addRemoteInput({ peerId: 'bob', tick: 0, actions: [], axes: {}, seq: 1 });

    const advanced = sync.advanceTick(1 / 20);
    expect(advanced).toBe(true);

    const status = sync.getSyncStatus();
    expect(status.confirmedTick).toBe(0);
    expect(status.currentTick).toBe(1);
  });

  it('輸入未齊全時仍可推進（預測模式）', () => {
    // 只有 alice 的輸入
    inputBuf.addRemoteInput({ peerId: 'alice', tick: 0, actions: ['move'], axes: {}, seq: 1 });

    const advanced = sync.advanceTick(1 / 20);
    expect(advanced).toBe(true);

    const status = sync.getSyncStatus();
    expect(status.confirmedTick).toBe(-1); // bob 的輸入沒到
    expect(status.currentTick).toBe(1);
  });

  it('預測過多時暫停等待', () => {
    // 推進 6 個 tick（maxPredictionAhead=5）
    for (let i = 0; i < 6; i++) {
      sync.advanceTick(1 / 20);
    }

    // 第 7 個 tick 應該被擋住
    const advanced = sync.advanceTick(1 / 20);
    expect(advanced).toBe(false);

    const status = sync.getSyncStatus();
    expect(status.isWaiting).toBe(true);
  });

  it('產生狀態雜湊', () => {
    inputBuf.addRemoteInput({ peerId: 'alice', tick: 0, actions: [], axes: {}, seq: 1 });
    inputBuf.addRemoteInput({ peerId: 'bob', tick: 0, actions: [], axes: {}, seq: 1 });
    sync.advanceTick(1 / 20);

    const hash = sync.getStateHash(0);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
    expect(hash!.length).toBe(8); // FNV-1a 32-bit hex
  });

  it('verifyStateHash 比對雜湊', () => {
    inputBuf.addRemoteInput({ peerId: 'alice', tick: 0, actions: [], axes: {}, seq: 1 });
    inputBuf.addRemoteInput({ peerId: 'bob', tick: 0, actions: [], axes: {}, seq: 1 });
    sync.advanceTick(1 / 20);

    const hash = sync.getStateHash(0)!;
    expect(sync.verifyStateHash(0, hash)).toBe(true);
    expect(sync.verifyStateHash(0, 'deadbeef')).toBe(false);
  });
});

describe('NetworkSyncManager — 回溯', () => {
  let world: World;
  let inputBuf: InputBuffer;
  let sync: NetworkSyncManager;

  beforeEach(() => {
    world = new World();
    // 簡單的計數系統：每 tick 把 counter.value 加上 input actions 長度
    world.registerSystem({
      name: 'counter-system',
      requiredComponents: ['counter'],
      priority: 0,
      update(entities, w) {
        for (const eid of entities) {
          const c = w.getComponent<{ value: number }>(eid, 'counter')!;
          c.value += 1; // 簡單 +1
        }
      },
    });

    const entity = world.createEntity('test');
    world.addComponent(entity, 'counter', { value: 0 });

    inputBuf = new InputBuffer({ inputDelay: 0 });
    sync = new NetworkSyncManager(world, inputBuf, {
      maxPredictionAhead: 10,
      maxSnapshots: 30,
    });

    inputBuf.addPeer('alice');
    inputBuf.addPeer('bob');
  });

  it('遲到的輸入不需要回溯時直接接受', () => {
    // tick 0: alice 和 bob 都有
    inputBuf.addRemoteInput({ peerId: 'alice', tick: 0, actions: [], axes: {}, seq: 1 });
    inputBuf.addRemoteInput({ peerId: 'bob', tick: 0, actions: [], axes: {}, seq: 1 });
    sync.advanceTick(1 / 20);

    // 遲到的輸入但 tick 0 已經齊全 → 不需回溯
    const rolled = sync.onRemoteInputReceived({
      peerId: 'bob', tick: 0, actions: [], axes: {}, seq: 2,
    });
    expect(rolled).toBe(false);
  });

  it('回溯事件監聽器被呼叫', () => {
    const rollbackHandler = vi.fn();
    sync.onRollback(rollbackHandler);

    // 推進幾個 tick（bob 的輸入缺失，用預測）
    inputBuf.addRemoteInput({ peerId: 'alice', tick: 0, actions: ['a'], axes: {}, seq: 1 });
    inputBuf.addRemoteInput({ peerId: 'alice', tick: 1, actions: ['a'], axes: {}, seq: 2 });
    sync.advanceTick(1 / 20);
    sync.advanceTick(1 / 20);

    // bob 的 tick 0 輸入遲到，且與預測不同（預測是空，實際有 action）
    const rolled = sync.onRemoteInputReceived({
      peerId: 'bob', tick: 0, actions: ['surprise'], axes: {}, seq: 1,
    });

    expect(rolled).toBe(true);
    expect(rollbackHandler).toHaveBeenCalled();
    expect(rollbackHandler.mock.calls[0][0].triggerPeerId).toBe('bob');
  });

  it('getSyncStatus 回傳正確的同步狀態', () => {
    const status = sync.getSyncStatus();
    expect(status.confirmedTick).toBe(-1);
    expect(status.currentTick).toBe(0);
    expect(status.predictionAhead).toBe(1);
    expect(status.rollbackCount).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GameStateValidator
// ══════════════════════════════════════════════════════════════════════════════

describe('GameStateValidator — 基本驗證', () => {
  let validator: GameStateValidator;

  beforeEach(() => {
    validator = new GameStateValidator('local', {
      validationInterval: 5,
      desyncThreshold: 3,
    });
    validator.addPeer('remote-a');
    validator.addPeer('remote-b');
  });

  it('shouldValidate 在正確的間隔回傳 true', () => {
    expect(validator.shouldValidate(0)).toBe(false);
    expect(validator.shouldValidate(5)).toBe(true);
    expect(validator.shouldValidate(10)).toBe(true);
    expect(validator.shouldValidate(7)).toBe(false);
  });

  it('所有節點雜湊一致時 consistent=true', () => {
    validator.submitHash(5, 'local', 'abc123');
    validator.submitHash(5, 'remote-a', 'abc123');
    validator.submitHash(5, 'remote-b', 'abc123');

    const result = validator.getResult(5)!;
    expect(result.consistent).toBe(true);
    expect(result.majorityHash).toBe('abc123');
    expect(result.desyncedPeers).toEqual([]);
  });

  it('有節點雜湊不同時偵測 desync', () => {
    validator.submitHash(5, 'local', 'abc123');
    validator.submitHash(5, 'remote-a', 'abc123');
    validator.submitHash(5, 'remote-b', 'WRONG!');

    const result = validator.getResult(5)!;
    expect(result.consistent).toBe(false);
    expect(result.desyncedPeers).toEqual(['remote-b']);
    expect(validator.getConsecutiveDesyncs('remote-b')).toBe(1);
  });

  it('多數決選出正確的雜湊', () => {
    validator.submitHash(5, 'local', 'correct');
    validator.submitHash(5, 'remote-a', 'correct');
    validator.submitHash(5, 'remote-b', 'wrong');

    const result = validator.getResult(5)!;
    expect(result.majorityHash).toBe('correct');
  });

  it('雜湊尚未齊全時不自動驗證', () => {
    validator.submitHash(5, 'local', 'abc');
    validator.submitHash(5, 'remote-a', 'abc');
    // remote-b 還沒送 → 不應自動觸發驗證
    expect(validator.getResult(5)).toBeUndefined();
  });
});

describe('GameStateValidator — 連續 desync 警報', () => {
  let validator: GameStateValidator;

  beforeEach(() => {
    validator = new GameStateValidator('local', {
      validationInterval: 5,
      desyncThreshold: 2,
    });
    validator.addPeer('cheater');
  });

  it('連續 desync 達到門檻時觸發警報', () => {
    const alertHandler = vi.fn();
    validator.onDesyncAlert(alertHandler);

    // 第一次 desync
    validator.submitHash(5, 'local', 'good');
    validator.submitHash(5, 'cheater', 'bad1');
    expect(alertHandler).not.toHaveBeenCalled();

    // 第二次 desync（達到 threshold=2）
    validator.submitHash(10, 'local', 'good');
    validator.submitHash(10, 'cheater', 'bad2');
    expect(alertHandler).toHaveBeenCalledWith('cheater', 2);
  });

  it('中間有一次一致會重置計數', () => {
    // desync #1
    validator.submitHash(5, 'local', 'a');
    validator.submitHash(5, 'cheater', 'b');
    expect(validator.getConsecutiveDesyncs('cheater')).toBe(1);

    // 一致 → 重置
    validator.submitHash(10, 'local', 'same');
    validator.submitHash(10, 'cheater', 'same');
    expect(validator.getConsecutiveDesyncs('cheater')).toBe(0);

    // desync → 又從 1 開始
    validator.submitHash(15, 'local', 'x');
    validator.submitHash(15, 'cheater', 'y');
    expect(validator.getConsecutiveDesyncs('cheater')).toBe(1);
  });

  it('getSuspiciousPeers 回傳可疑的節點', () => {
    validator.submitHash(5, 'local', 'a');
    validator.submitHash(5, 'cheater', 'b');
    validator.submitHash(10, 'local', 'a');
    validator.submitHash(10, 'cheater', 'c');

    expect(validator.getSuspiciousPeers()).toEqual(['cheater']);
  });

  it('desync 事件監聽器收到正確的資訊', () => {
    const desyncHandler = vi.fn();
    validator.onDesync(desyncHandler);

    validator.submitHash(5, 'local', 'expected');
    validator.submitHash(5, 'cheater', 'actual');

    expect(desyncHandler).toHaveBeenCalledWith(expect.objectContaining({
      peerId: 'cheater',
      tick: 5,
      expectedHash: 'expected',
      actualHash: 'actual',
      consecutiveDesyncs: 1,
    }));
  });
});

describe('GameStateValidator — 清理', () => {
  it('removePeer 清除該 peer 的狀態', () => {
    const v = new GameStateValidator('local');
    v.addPeer('peer-x');

    v.submitHash(5, 'local', 'a');
    v.submitHash(5, 'peer-x', 'b');
    expect(v.getConsecutiveDesyncs('peer-x')).toBe(1);

    v.removePeer('peer-x');
    expect(v.getConsecutiveDesyncs('peer-x')).toBe(0);
  });

  it('destroy 清空所有狀態', () => {
    const v = new GameStateValidator('local');
    v.addPeer('peer-1');
    v.submitHash(5, 'local', 'a');
    v.submitHash(5, 'peer-1', 'a');

    v.destroy();
    expect(v.getResult(5)).toBeUndefined();
    expect(v.getSuspiciousPeers()).toEqual([]);
  });
});
