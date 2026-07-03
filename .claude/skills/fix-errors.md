---
name: fix-errors
description: Auto-diagnose and fix TypeScript, test, and build errors in the Nerilo project
---

# Nerilo Error Auto-Fix

## Steps

1. **TypeScript Check**
   ```bash
   node ./node_modules/typescript/bin/tsc --noEmit 2>&1
   ```
   If errors found → read the files, fix the type errors, re-run to verify.

2. **Unit Tests**
   ```bash
   node ./node_modules/vitest/vitest.mjs run 2>&1
   ```
   If failures found → read the failing test and source file, determine if the test or the source is wrong, fix accordingly, re-run to verify.

3. **Lint**
   ```bash
   npm run lint 2>&1
   ```
   If errors found → fix them.

4. **Console.log Residuals**
   Search for console.log/warn/error in src/ (should use logger instead).
   Exclude: logger.ts, firebase.ts, featureLog.ts
   If found → migrate to logger.

5. After all fixes, commit with message:
   ```
   fix: auto-fix — [describe what was fixed]
   ```

## Rules
- Never introduce new features — only fix existing code
- If a test is genuinely wrong (testing old behavior), update the test
- If source code has a bug, fix the source
- Always re-run verification after each fix
- If stuck after 3 attempts on the same error, report to user
