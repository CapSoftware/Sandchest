# React Doctor — Web App Baseline Audit

**Date:** 2026-02-21 (updated)
**Scope:** `apps/web/src/` — React components, lib modules, test files
**Framework:** Next.js 15.3.3 | **React version:** 19.2.4

---

## Overall Score: 81/100

| Category | Score | Max | Notes |
|----------|-------|-----|-------|
| Hook Hygiene | 9 | 10 | All effects are external-system sync; no anti-patterns |
| State Management | 8 | 10 | Minimal state |
| Performance | 8 | 10 | Index keys in output (append-only, acceptable) |
| Accessibility | 8 | 10 | aria-expanded, aria-label, sr-only on all interactive widgets |
| TypeScript Strictness | 8 | 10 | Strict mode enabled |
| Test Coverage | 6 | 10 | Utilities fully tested; zero component-level tests |
| Error Handling | 9 | 10 | Proper user-facing errors; no ErrorBoundary |
| Code Organization | 9 | 10 | Clean separation, co-located tests, focused components |
| Security | 8 | 10 | Credentials include, key shown once; clipboard lacks error handling |
| Bundle Efficiency | 8 | 10 | Next.js App Router with proper server/client boundaries |

---

## Fixed Issues

The following issues from the initial audit have been resolved:

1. **aria-expanded on ExecCard toggle** — Added `aria-expanded={expanded}` to the expand/collapse button
2. **aria-label on error icon** — Added `role="img" aria-label="Private"` to the lock emoji
3. **Label on invite email input** — Added `aria-label="Invite email address"` to the input
4. **Uncleaned setTimeout in OrgSettings** — Timer now uses `useRef` with `useEffect` cleanup
5. **Empty `<th>` elements** — Added `<th scope="col"><span className="sr-only">Actions</span></th>` to ApiKeyManager and OrgSettings
6. **URL parsing on every render** — Resolved by migration to Next.js `useSearchParams()` hook
7. **`client:load` hydration** — No longer applicable; migrated from Astro islands to Next.js App Router

---

## Remaining Issues

### P2 — Nice to Fix

#### 1. Index keys for output entries
**File:** `components/replay/ReplayViewer.tsx`
**Category:** Performance
Output entries use `key={i}` (array index). These are append-only and immutable after load, so impact is minimal.

### P3 — Low Priority

#### 2. No React ErrorBoundary
**Category:** Error Handling
No `ErrorBoundary` wraps the app. An unhandled error in a React component will crash with a white screen.

#### 3. Component-level tests
**Category:** Test Coverage
All pure functions in `lib/` have thorough tests, but no component-level tests exist for user flows.

---

## What's Working Well

- **Zero useEffect anti-patterns.** All effects are external-system sync (data fetching, focus management, redirects).
- **Proper async cancellation.** `ReplayViewer` uses a `cancelled` flag in its fetch effect cleanup.
- **Good accessibility baseline.** Forms use `htmlFor`/`id` pairing, `role="alert"` for errors, `role="status"` for success, `aria-label` on OTP inputs, `aria-expanded` on toggles.
- **Clean state management.** Components use minimal `useState`.
- **Security-conscious API key handling.** Key shown once, then masked.
- **Utility test coverage.** All pure functions in `lib/` have thorough tests with edge cases.
- **No barrel re-exports or circular dependencies.**

---

## Test Suite

`react-doctor.test.ts` — **299 tests, all passing**

The test suite programmatically audits all `.tsx` components for:
- useEffect anti-patterns (derived state, chained effects, notify-parent)
- Raw string throws
- `any` type annotations
- `console.log` in production code
- Form input accessibility (labels/aria-label)
- Icon button accessibility
- Error message `role="alert"` usage
- List key patterns
- Inline style counts
- useCallback dependency arrays
- Baseline score tracking

Regressions cause test failures; improvements can be tracked by updating the expected score.

---

## Recommendations (Prioritized)

1. Add a root `ErrorBoundary` to catch rendering errors
2. Add component-level tests for key user flows (OTP input, sandbox list)
