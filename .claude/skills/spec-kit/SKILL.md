---
name: spec-kit
description: Nerilo 規格驅動開發（SDD）工作流——specify→clarify→plan→tasks→analyze→implement，憲法裁決、雙軌規格（feature/protocol）。當使用者要「寫 spec」「開規格」「規格驅動」「先把需求講清楚再做」「訂協議規格」「動核心不變量/SDK 表面/協議格式的新功能」時使用。凡改動會碰四條核心不變量、公開 SDK 表面、跨實作協議、或跨兩個以上模組，動手前必用。
---

# spec-kit — Nerilo 規格驅動開發

採 GitHub Spec Kit 的精神（規格是一等公民、憲法裁決、先講清楚才動手），用本專案原語實作：零外部 CLI，implement 閘門直接沿用 harden-tests（比原裝強）。

## 何時要 spec（憲法第 14 條）

會動到 **四條核心不變量／公開 SDK 表面／協議格式／跨兩個以上模組** 的工作 → 先 spec。
一句話講得清楚且不碰上述四類 → 免 spec，直接做。不要為儀式而儀式。

## 檔案結構

```
specs/
├── constitution.md            # 專案憲法（最高裁決，先讀）
├── templates/
│   ├── spec-template.md       # feature 軌
│   └── protocol-spec-template.md  # protocol 軌（互通級，含 conformance）
└── NNN-短名/
    └── spec.md                # 一個規格一個目錄（編號遞增）
```

## 流程（每階段的動作與停點）

1. **specify**：讀 `specs/constitution.md` → 選軌（feature/protocol）→ 複製對應模板建 `specs/NNN-短名/spec.md` → 只填第 1-3 節（what/why/邊界/待釐清）。**不寫技術方案。**
2. **clarify**：把第 3 節的歧義逐條問使用者拍板（用 AskUserQuestion）。全部清空才准進 plan。這步防的是「AI 自行腦補需求」。
3. **plan**：填第 4 節。方案、動到的模組、取捨理由。若含重大架構取捨，標記「完成後回填 ADR-XXXX」。
4. **tasks**：填第 5 節。小步、可獨立驗證、按依賴排序；改運作中路徑的任務標 ⚠。
5. **analyze**：跑第 7 節自查清單，逐條打勾或修正。抓「方案沒覆蓋需求」「任務漏了方案的一塊」「驗收只證明跑得動不證明需求」三類毛病。
6. **implement**：逐任務執行。⚠ 任務先叫 `harden-tests` skill（characterization-first + 分層閘門 + 誠實條款）。每完成一個任務勾掉並更新 spec 狀態。
7. **收尾**：第 6 節驗收全綠 → 狀態改 done → 回填 ADR（若第 3 步有標）→ commit（規格與程式碼同 repo 演進）。

## 鐵律

1. **憲法優先**：spec 與憲法衝突時，改 spec 或先修憲（修憲要使用者拍板），不准默默繞過。
2. **clarify 未清空不進 plan**：歧義留到實作期，成本放大十倍。
3. **spec 是活文件**：實作發現 spec 錯了，改 spec 並在該節標記「〔實作期修訂〕」，不默默偏離。
4. **protocol 軌加嚴**：必須實作無關（不拿 TS 型別當定義）、必須含 conformance 測試向量、變更必須含版本與相容策略。
5. 台灣用語；對外可見的 spec（protocol 軌）遵守去AI感慣例。

## 與既有工具的分工

- goal 排序疑慮 → `docs/PROMPT-goal-checkpoint.md`（要不要做）；spec-kit 管「做什麼與怎麼做」。
- 領域建模需求 → 先 `/ddd-design`（專案版 prompt 在 docs/DDD設計_Nerilo_專案版.md），其產出（聚合/不變條件）餵進 spec 第 4 節。
- 實作閘門 → `harden-tests`，spec-kit 不重複定義測試紀律。
