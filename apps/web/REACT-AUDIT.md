# React Doctor — Web App Baseline Audit

**Date:** 2026-02-21
**Scope:** `apps/web/src/` — 6 React components, 5 lib modules, 3 test files
**React version:** 19.2.4 | **Astro version:** 5.2.0

---

## Overall Score: 78/100

| Category | Score | Max | Notes |
|----------|-------|-----|-------|
| Hook Hygiene | 9 | 10 | All effects are external-system sync; no anti-patterns |
| State Management | 8 | 10 | Minimal state; minor: URL parsing on every render |
| Performance | 7 | 10 | Index keys in output, uncleaned timeouts, all `client:load` |
| Accessibility | 6 | 10 | Good labels/ARIA on forms; missing on interactive widgets |
| TypeScript Strictness | 8 | 10 | Strict mode; two unsafe `as unknown` casts |
| Test Coverage | 6 | 10 | Utilities fully tested; zero component-level tests |
| Error Handling | 9 | 10 | Proper user-facing errors; no ErrorBoundary |
| Code Organization | 9 | 10 | Clean separation, co-located tests, focused components |
| Security | 8 | 10 | Credentials include, key shown once; clipboard lacks error handling |
| Bundle Efficiency | 8 | 10 | All dashboard components eagerly loaded (`client:load`) |

---

## Issues Found

### P1 — Should Fix

#### 1. Missing `aria-expanded` on ExecCard toggle
**File:** `components/replay/ReplayViewer.tsx:61-65`
**Category:** Accessibility
The exec card expand/collapse button uses a chevron (`▾`/`▸`) but lacks `aria-expanded` to communicate state to assistive tech.

#### 2. Missing `aria-label` on error icon
**File:** `components/replay/ReplayViewer.tsx:186`
**Category:** Accessibility
The lock emoji (`&#128274;`) used as an error icon has no `aria-label` or `role="img"`. Screen readers will announce the raw Unicode character.

#### 3. Missing label on invite email input
**File:** `components/dashboard/OrgSettings.tsx:232`
**Category:** Accessibility
The invite email `<input>` has no associated `<label>` or `aria-label`. Placeholder text alone is insufficient for accessibility.

#### 4. Uncleaned `setTimeout` in ApiKeyManager
**File:** `components/dashboard/ApiKeyManager.tsx:96`
**Category:** Performance / Correctness
`setTimeout(() => setCopied(false), 2000)` is never cleared. If the component unmounts within 2s, this calls `setState` on an unmounted component.

#### 5. Uncleaned `setTimeout` in OrgSettings
**File:** `components/dashboard/OrgSettings.tsx:81`
**Category:** Performance / Correctness
Same pattern: `setTimeout(() => setUpdateSuccess(false), 3000)` is never cleared.

### P2 — Nice to Fix

#### 6. URL parsing on every render in VerifyOtpForm
**File:** `components/auth/VerifyOtpForm.tsx:13-16`
**Category:** Performance
`new URLSearchParams(window.location.search)` is called on every render. Since the URL doesn't change during this component's lifetime, this should be computed once (e.g., outside the component or in a `useMemo`).

#### 7. Unsafe type casts in OrgSettings
**File:** `components/dashboard/OrgSettings.tsx:51-53`
**Category:** TypeScript Strictness
Triple `as unknown as X` casts bypass TypeScript entirely. These should use BetterAuth's own types or a validated transform.

#### 8. Index keys for output entries
**File:** `components/replay/ReplayViewer.tsx:89`
**Category:** Performance
Output entries use `key={i}` (array index). These are append-only and immutable after load, so impact is minimal, but a content hash or entry timestamp would be more robust.

#### 9. All dashboard pages use `client:load`
**Files:** `pages/dashboard/*.astro`
**Category:** Bundle Efficiency
All three dashboard pages use `client:load` which eagerly hydrates React. `client:idle` would defer hydration until the browser is idle, improving perceived performance on slower devices.

### P3 — Low Priority

#### 10. No React ErrorBoundary
**Category:** Error Handling
No `ErrorBoundary` wraps any React island. An unhandled error in a React component will crash the entire island with a white screen.

#### 11. Empty `<th>` elements without scope
**Files:** `SandboxList.tsx:121`, `ApiKeyManager.tsx:174`, `OrgSettings.tsx:205`
**Category:** Accessibility
Action columns have empty `<th>` elements. Adding `<th scope="col"><span class="sr-only">Actions</span></th>` would help screen readers.

#### 12. `mobile-dash-btn` missing `aria-expanded`
**File:** `layouts/DashboardLayout.astro:44`
**Category:** Accessibility
The mobile menu toggle button has `aria-label` but not `aria-expanded`. State should be toggled in the click handler.

---

## What's Working Well

- **Zero useEffect anti-patterns.** All 5 effects are external-system sync (data fetching, focus management, redirects). No derived-state-in-effects, no chained effects, no effects-to-notify-parent.
- **Proper async cancellation.** `ReplayViewer` uses a `cancelled` flag in its fetch effect cleanup — correct pattern.
- **Good accessibility baseline.** Forms use `htmlFor`/`id` pairing, `role="alert"` for errors, `role="status"` for success, `aria-label` on OTP inputs.
- **Clean state management.** Components use minimal `useState`. `Set<string>` for tracking in-flight mutations is a good pattern.
- **Security-conscious API key handling.** Key shown once, then masked. Good UX + security.
- **Utility test coverage.** All pure functions in `lib/` have thorough tests with edge cases.
- **No barrel re-exports or circular dependencies.**
- **ESM imports with `.js` extensions** per project convention.

---

## Typecheck Findings

`astro check` — **0 errors, 0 warnings, 7 hints**:

- 2x unused `weak` variable in `BentoGrid.astro:147` and `Cta.astro:147` (canvas animation helpers)
- 5x deprecated `React.FormEvent` in React 19 — should migrate to `React.FormEvent` from `react` namespace directly (affects EmailForm, VerifyOtpForm, ApiKeyManager, OrgSettings)

---

## Test Suite

`react-doctor.test.ts` — **68 tests, all passing**

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

Known issues are documented as expected baseline values in the test, so regressions will cause failures and improvements can be tracked by updating the expected values.

---

## Recommendations (Prioritized)

1. Add `aria-expanded` to all toggle buttons (ExecCard, mobile menu)
2. Add labels to all form inputs (invite email)
3. Add `role="alert"` to dashboard error messages (3 components)
4. Clean up `setTimeout` calls with `useEffect` return or `useRef` for timer IDs
5. Add a root `ErrorBoundary` to catch rendering errors in React islands
6. Move URL parsing out of render path in VerifyOtpForm
7. Replace `as unknown` casts with proper BetterAuth types
8. Consider `client:idle` for non-critical dashboard pages
9. Add component-level tests for key user flows (OTP input, sandbox list)
