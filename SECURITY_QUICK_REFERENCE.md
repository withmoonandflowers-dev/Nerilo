# Security Quick Reference - Nerilo Project

## Critical Vulnerabilities Checklist

### 🔴 CRITICAL (Fix immediately - 24 hours)

- [ ] **Hardcoded API Key**
  - Location: `src/config/firebase.ts:18,22,26,30,34,38`
  - Key: `AIzaSy_REDACTED_ROTATED_KEY`
  - Action: Rotate in Firebase Console, update to env vars only
  - Command: `git filter-branch --tree-filter 'git rm --cached env.local' HEAD`

- [ ] **Console Logging Exposes Secrets**
  - Locations: 280+ instances across codebase
  - Problem: `DEBUG_AUTH=true` logs user UIDs, claims, room data
  - Action: Create logger utility, replace console with conditional logging
  - Example: `src/contexts/AuthContext.tsx:73` logs customClaims

- [ ] **Missing Security Headers**
  - Location: `firebase.json` hosting.headers
  - Missing: HSTS, CSP, X-XSS-Protection
  - Action: Add headers before next deployment

---

## High Priority Fixes (1-2 weeks)

### 🟠 A05: Security Misconfiguration
**Status: FAIL**

```typescript
// BEFORE: ❌ Hardcoded keys
const firebaseConfig = {
  apiKey: 'AIzaSy_REDACTED_ROTATED_KEY',  // EXPOSED!
  projectId: 'nerilo',
};

// AFTER: ✓ Environment variables
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};
```

### 🟠 A08: Data Integrity - SDP Not Signed
**Status: PARTIAL**

Location: `src/core/p2p/P2PConnectionManager.ts:318-350`

```typescript
// BEFORE: ❌ Plaintext SDP
async sendSignal(type: 'offer' | 'answer' | 'ice', payload: any) {
  // SDP stored as plaintext - vulnerable to tampering
  await addDoc(signalsRef, {
    payload: serializedPayload,  // Not signed!
  });
}

// AFTER: ✓ Signed SDP
async sendSignal(type: 'offer' | 'answer' | 'ice', payload: any) {
  const signature = await this.securityManager.sign(serializedPayload);
  await addDoc(signalsRef, {
    payload: serializedPayload,
    signature,  // Cryptographic proof of authenticity
  });
}
```

### 🟠 A07: Authentication - Anonymous Fallback
**Status: PARTIAL**

Location: `src/contexts/AuthContext.tsx:44-52`

```typescript
// BEFORE: ❌ Auto-authenticates anonymous users
onAuthStateChanged(auth, async (firebaseUser) => {
  if (firebaseUser) {
    await loadUserData(firebaseUser);
  } else {
    // Auto-signup as anonymous! Security concern.
    const anonymousUser = await signInAnonymously(auth);
  }
});

// AFTER: ✓ Require explicit authentication
onAuthStateChanged(auth, async (firebaseUser) => {
  if (firebaseUser) {
    await loadUserData(firebaseUser);
  } else {
    setUser(null);  // Show login screen, don't auto-authenticate
    setLoading(false);
  }
});
```

### 🟠 A09: Logging & Monitoring - Debug Logs
**Status: FAIL**

Location: `src/contexts/AuthContext.tsx:17` and throughout codebase

```typescript
// BEFORE: ❌ Always logs sensitive data
const DEBUG_AUTH = true;  // Hardcoded!
console.log('[Auth] loadUserData', {
  uid: firebaseUser.uid,      // Visible in DevTools!
  claims: tokenResult.claims,  // Exposes roles, permissions
});

// AFTER: ✓ Conditional, environment-aware logging
import { createLogger } from '../utils/logger';
const log = createLogger('[Auth]');
log.debug('loadUserData', { uid: '***hidden***' });  // Masked in prod
```

---

## Medium Priority Fixes (2-4 weeks)

### 🟡 A04: Insecure Design - Connection Timeout
Location: `src/core/p2p/P2PConnectionManager.ts`

```typescript
// BEFORE: ❌ No timeout - connection hangs indefinitely
async initialize(): Promise<void> {
  await this.connectionManager.initialize();
  // No timeout if negotiation stalls...
}

// AFTER: ✓ 60-second timeout
private async ensureConnection(timeoutMs = 60000): Promise<void> {
  return Promise.race([
    this.connectionManager.initialize(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), timeoutMs)
    ),
  ]);
}
```

### 🟡 A04: Insecure Design - Rate Limiting
Location: Firestore rules signals collection

```javascript
// BEFORE: ❌ Unlimited signal writes
match /signals/{signalId} {
  allow create: if isAuthenticated();  // No rate limit!
}

// AFTER: ✓ Rate limit enforcement (with Cloud Function)
// Client-side: Implement debouncing
// Server-side: Cloud Function to track per-user signal rate
```

### 🟡 WebRTC: ICE Candidate Filtering
Location: `src/core/p2p/P2PConnectionManager.ts:97-100`

```typescript
// BEFORE: ❌ All ICE candidates stored (includes local IPs)
this.pc.onicecandidate = (event) => {
  if (event.candidate) {
    this.sendSignal('ice', event.candidate);  // Includes 192.168.x.x
  }
};

// AFTER: ✓ Filter host candidates
this.pc.onicecandidate = (event) => {
  if (event.candidate && event.candidate.type !== 'host') {
    this.sendSignal('ice', event.candidate);
  }
};
```

---

## Firestore Rules Issues

### 🔴 A01: Broken Access Control - User Profile Enumeration
Location: `firestore.rules:43-45`

```javascript
// BEFORE: ❌ Any authenticated user can read any profile
match /users/{uid} {
  allow read: if isAuthenticated();  // No ownership check!
}

// AFTER: ✓ Only read own profile
match /users/{uid} {
  allow read: if isAuthenticated() && isOwner(uid);
}
```

### 🟠 A04: Insecure Design - Signal Payload Size
Location: `firestore.rules:95`

```javascript
// Current: ✓ 10KB limit (good)
allow create: if request.resource.size() < 10 * 1024;

// Consider: Add offer/answer size limits too
// Maximum SDP size should be ~5KB for practical connections
```

---

## Logging Issues - Replace Pattern

### Find all console logs:
```bash
grep -r "console\." src --include="*.ts" --include="*.tsx"
# Found 280+ instances
```

### Create Logger Utility:
```typescript
// src/utils/logger.ts
export function createLogger(namespace: string) {
  return {
    debug: (msg: string, data?: any) => {
      if (import.meta.env.DEV) {
        console.log(`[${namespace}]`, msg, data);
      }
    },
    error: (msg: string, err?: any) => {
      console.error(`[${namespace}]`, msg, err);
      // Send to error tracking in production
    },
  };
}
```

### Replace Pattern:
```typescript
// BEFORE:
console.log('[Auth] loadUserData', {
  uid: firebaseUser.uid,
  isAnonymous: firebaseUser.isAnonymous,
  role,
});

// AFTER:
const log = createLogger('[Auth]');
log.debug('loadUserData', { role });  // Don't log UIDs/sensitive data
```

---

## Testing Checklist

- [ ] **No console logs in production build**
  ```bash
  npm run build && grep -r "console\." dist
  ```

- [ ] **Security headers present**
  ```bash
  curl -i https://nerilo-prod.web.app/ | grep -i "strict-transport\|content-security\|x-xss"
  ```

- [ ] **API key not in code**
  ```bash
  grep -r "AIzaSy" src
  ```

- [ ] **No env.local in git**
  ```bash
  git log --all --full-history -- env.local
  ```

- [ ] **Auth timeout works**
  - Manual test: Leave app idle 30 mins, verify logout/re-auth required

- [ ] **SDP signing works**
  - Verify offer/answer includes signature field
  - Verify signature validates correctly

---

## Deployment Checklist

- [ ] Environment variables configured in Firebase Console
- [ ] Security headers deployed in firebase.json
- [ ] Database rules deployed and tested
- [ ] Cloud Functions deployed (if using TURN)
- [ ] git history cleaned (credentials removed)
- [ ] npm audit passing
- [ ] No console logs in production build
- [ ] Security headers verified in production
- [ ] Monitoring/alerting configured

---

## Firestore Rules Reference (Current State)

### ✓ Well Implemented
- Mesh identity validation (8-64 char userId, 40-512 char pubKey)
- Signal append-only (no updates/deletes)
- Payload size limit (10KB)
- Room ownership checks
- Participant validation

### ✗ Needs Improvement
- User profile readable by any authenticated user
- No rate limiting on signals
- No SDP signature requirement
- Host candidates exposed in signals

---

## Links to Detailed Issues

| Issue | Severity | File | Lines | Status |
|-------|----------|------|-------|--------|
| Hardcoded API Key | CRITICAL | src/config/firebase.ts | 18,22,26,30,34,38 | FAIL |
| Console Logging | HIGH | src/contexts/AuthContext.tsx | 17,73 | FAIL |
| Missing Headers | CRITICAL | firebase.json | headers | FAIL |
| No SDP Signing | MEDIUM | src/core/p2p/P2PConnectionManager.ts | 318-350 | PARTIAL |
| Anonymous Fallback | MEDIUM | src/contexts/AuthContext.tsx | 44-52 | PARTIAL |
| User Profile Enum | MEDIUM | firestore.rules | 43-45 | PARTIAL |
| No Timeout | MEDIUM | src/core/p2p/P2PConnectionManager.ts | 36-78 | PARTIAL |
| No Rate Limit | MEDIUM | firestore.rules | 90-97 | PARTIAL |
| ICE IP Leak | MEDIUM | src/core/p2p/P2PConnectionManager.ts | 97-100 | PARTIAL |

---

## Quick Commands

### Rotate Firebase Key
```bash
# In Firebase Console: Settings > Service Accounts > Generate new private key
# OR: Create new web API key
# Then: Update VITE_FIREBASE_API_KEY in CI/CD secrets
```

### Clean Git History
```bash
# Option 1: Using bfg-repo-cleaner (faster)
bfg --replace-text replacements.txt

# Option 2: Using git filter-branch
git filter-branch --tree-filter 'git rm --cached env.local' HEAD

# Verify
git log --all --full-history -- env.local
```

### Build without console logs
```bash
npm run build  # Check dist/ for console references
```

### Deploy new security headers
```bash
# Update firebase.json, then:
firebase deploy --only hosting
```

---

## References

- OWASP Top 10: https://owasp.org/Top10/
- WebRTC Security (RFC 8827): https://tools.ietf.org/html/rfc8827
- Firebase Security: https://firebase.google.com/docs/rules
- HSTS/CSP/Security Headers: https://owasp.org/www-project-secure-headers/

---

**Last Updated:** 2026-03-22
**Critical Issues:** 2 (API key, logging)
**High Priority:** 1 (missing headers)
**Medium Priority:** 19 (various)
