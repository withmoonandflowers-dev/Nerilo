---
name: pre-deploy-check
description: Run all quality gates before deployment — TypeScript, tests, lint, audit
---

# Pre-Deploy Quality Gate

Run the full quality pipeline and report results:

```bash
# 1. TypeScript
echo "=== TypeScript ===" && node ./node_modules/typescript/bin/tsc --noEmit 2>&1

# 2. Unit Tests
echo "=== Tests ===" && node ./node_modules/vitest/vitest.mjs run 2>&1 | tail -8

# 3. Lint
echo "=== Lint ===" && npm run lint 2>&1 | tail -5

# 4. Build
echo "=== Build ===" && npm run build 2>&1 | tail -10
```

Report format:
```
## Pre-Deploy Report
- TypeScript: PASS/FAIL (X errors)
- Tests: PASS/FAIL (X passed / Y failed)
- Lint: PASS/FAIL (X warnings)
- Build: PASS/FAIL (bundle size)
- Decision: READY / NOT READY
```

If NOT READY, list all blockers. If READY, confirm safe to deploy.
