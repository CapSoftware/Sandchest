/**
 * Recognising test, fixture and example code. Attackers do not reach it in
 * production, and benchmark apps bury deliberately-broken sample servers under
 * these directories (Bun's thousands of test servers, for instance). We never
 * *drop* anything found there — deterministic leads must always surface — but
 * we rank product code ahead of it so capped budgets (sink leads, access-control
 * hunters) spend on what actually ships first.
 */
const FIXTURE_SEGMENT = /(^|\/)(tests?|__tests__|__mocks__|fixtures?|testdata|mocks?|bench|benchmarks?|spec|specs|examples?|e2e|stories|cypress|playwright|\.storybook)(\/|$)/i;

/** Whether a checkout-relative path is under a test/fixture/example directory. */
export function isFixtureFile(file: string): boolean {
  return FIXTURE_SEGMENT.test(file);
}

/** Same, for a `file:line` citation (or a bare path). */
export function isFixtureAt(at: string | undefined): boolean {
  if (!at) return false;
  return isFixtureFile(at.replace(/:\d+$/, ""));
}

// A dot-directory segment (.agents/, .storybook/, .github/) or a build/test config file.
const DOTDIR_SEGMENT = /(^|\/)\.[^/]+\//;
const CONFIG_FILE = /\.config\.[cm]?[jt]sx?$/;
// Test files and test setup outside a test directory (a.test.ts, Button.stories.tsx, test-setup.ts, x_test.go), and example apps.
const TEST_FILE = /(^|\/)([^/]+\.(test|spec|stories)\.[cm]?[jt]sx?|(test-?setup|setup-?tests?|vitest\.setup|jest\.setup)\.[cm]?[jt]sx?|[^/]+_test\.go|test_[^/]+\.py|[^/]+_test\.py)$/i;
const EXAMPLE_SEGMENT = /(^|\/)example-apps?\//i;

/** Not shipped as product: test/fixture dirs and files, example apps, dot-directories (tooling), or build/test config files. */
export function isNonProductFile(file: string): boolean {
  return isFixtureFile(file) || DOTDIR_SEGMENT.test(file) || CONFIG_FILE.test(file) || TEST_FILE.test(file) || EXAMPLE_SEGMENT.test(file);
}

/** Same, for a `file:line` citation (or a bare path). */
export function isNonProductAt(at: string | undefined): boolean {
  if (!at) return false;
  return isNonProductFile(at.replace(/:\d+$/, ""));
}

/** A stable reordering that puts product items before fixture items, keeping each group's order. */
export function productFirst<T>(items: readonly T[], at: (item: T) => string | undefined): T[] {
  const product: T[] = [];
  const fixture: T[] = [];
  for (const item of items) (isFixtureAt(at(item)) ? fixture : product).push(item);
  return [...product, ...fixture];
}
