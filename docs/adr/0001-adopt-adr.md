# ADR-0001：以 ADR 記錄架構決策

- 狀態：Accepted
- 日期：2026-07-03

## Context

專案文件豐富（架構、協議、威脅模型）但缺少「為什麼這樣決定」的記錄。
跨機器協作（見 docs/CROSS-MACHINE-HANDOFF.md）依賴 git 作為唯一溝通管道，
決策理由若只存在單一機器的記憶中會流失。商業化階段將出現多個高風險決策
（計費、配額、市場定位），需要可回溯的決策軌跡。

## Decision

在 docs/adr/ 以循序編號的 Markdown 記錄架構決策。格式：狀態、日期、Context、
Decision、Consequences。狀態流轉：Draft、Proposed、Accepted、Superseded。
既有的重大決策以「補記」方式回填（0002、0003）。

## Consequences

- 決策理由跨機器、跨 session 可追溯。
- 翻案必須開新 ADR 取代舊的，避免無聲翻案（docs/CROSS-MACHINE-HANDOFF.md 第 7 節「刻意的設計決定」應逐步移入 ADR）。
- 多一層文件維護成本，僅對「難以逆轉」的決策開 ADR，實作細節不進。
