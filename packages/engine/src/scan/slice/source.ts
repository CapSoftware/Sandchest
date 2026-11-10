/**
 * Which files a scan reads, for any language: source that can face an attacker, without frontend UI, tests,
 * docs, vendored or generated code. Plus the risk vocabulary that ranks them (web and native families).
 */

const SOURCE = /\.(ts|js|mjs|cjs|py|rb|go|java|kt|kts|scala|groovy|php|cs|fs|rs|ex|exs|erl|swift|m|mm|dart|lua|zig|sol|c|h|cc|cpp|cxx|hh|hpp|hxx|ipp|tsx|jsx|erb|ejs|hbs|twig|blade\.php|html)$/;
const SKIP_DIR = new RegExp(
  "(^|/)(tests?|__tests__|spec|specs|e2e|cypress|playwright|fixtures?|mocks?|__mocks__|testing|test-utils|testutils|" +
    "vendor|node_modules|dist|build|out|coverage|\\.next|\\.nuxt|generated|__generated__|gen|" +
    "migrations?|migrate|seeds?|db/schema|locales?|i18n|translations?|lang|" +
    "docs?|examples?|samples?|benchmarks?|storybook|stories|\\.storybook|" +
    "assets|static|public|images|fonts|styles?|css|scss|" +
    "frontend|client-side|webapp|web-ui|ui|components|widgets|views/components|app/javascript|app/frontend|" +
    "icons|emails/templates)(/|$)",
  "i",
);
/** Client-app directories. Skipped unless an earlier segment marks server code (`app/api/desktop/...`). */
const CLIENT_DIRS = new Set(["desktop", "mobile", "ios", "android", "electron", "extension"]);
const SERVER_MARKERS = new Set(["api", "server", "routes", "routers", "controllers", "trpc"]);
const SKIP_FILE = /\.(test|spec|stories|story|min|d|config|e2e)\.[a-z]+$|_test\.(go|py|rb|exs)$|(^|\/)test_[^/]*\.py$|(^|\/)conftest\.py$|\.generated\.|\.pb\.go$|_pb2\.py$/i;
/** A .tsx/.jsx file is server-side only as a Next.js route, page or layout, or a file that declares server code. */
const NEXT_SERVER = /(^|\/)app\/.*(^|\/)(page|layout|route|loading|error|not-found|template|default)\.(t|j)sx$|(^|\/)(server|api|routers?|trpc)\//;
const TEMPLATE = /\.(erb|ejs|hbs|twig|blade\.php|html)$/;
const TEMPLATE_DIR = /(^|\/)(views|templates)\//;

/** Web risk words: requests, auth, data access, injection, money. */
const WEB_WORDS =
  /\b(req|request|params|query|body|session|current_?user|auth\w*|authori[sz]\w*|permission\w*|policy|polic\w+|role|admin|owner\w*|user_?id|account|tenant|org\w*|team|member\w*|token|password|secret|api_?key|csrf|redirect|upload|download|file|path|exec|eval|system|spawn|shell|sql|raw|where|find\w*|select|insert|update|delete|destroy|fetch|http|url|webhook|billing|payment|invoice|credit|price|quota|limit|rate|import|export|serialize|deserialize|pickle|yaml|xml|template|render)\b/gi;
/** Native operations that actually move or size memory, plus pointer-arithmetic shapes. */
const NATIVE_WORDS =
  /\b(memcpy|memmove|memset|strcpy|strncpy|strcat|strncat|sprintf|vsprintf|gets|scanf|sscanf|alloca|malloc|calloc|realloc|recv|recvfrom|fread|read|unescape\w*|decode\w*|parse\w*|ntohl|ntohs|be\d+toh|le\d+toh|reinterpret_cast|transmute|unsafe|setuid|getenv)\b|\w+\s*\[[^\]]*\+[^\]]*\]|\+\+\s*\*|\*\s*\w+\s*\+\+/gi;
const NATIVE_EXT = /\.(c|h|cc|cpp|cxx|hh|hpp|hxx|ipp|m|mm|rs|zig)$/;

/** True when a client-app directory appears with no server marker before it. */
function inClientApp(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  for (let i = 0; i < segments.length; i++) {
    if (SERVER_MARKERS.has(segments[i]!)) return false;
    if (CLIENT_DIRS.has(segments[i]!)) return true;
  }
  return false;
}

/**
 * Whether a path is server code. A .tsx/.jsx file outside the Next.js server shapes counts only when `head`
 * (its first 200 characters) is given and declares `use server`.
 */
export function isServerFile(path: string, head?: string): boolean {
  if (!path || !SOURCE.test(path) || SKIP_DIR.test(path) || inClientApp(path) || SKIP_FILE.test(path)) return false;
  if ((path.endsWith(".tsx") || path.endsWith(".jsx")) && !NEXT_SERVER.test(path)) {
    if (head === undefined || !head.includes("use server")) return false;
  }
  if (TEMPLATE.test(path) && !TEMPLATE_DIR.test(path)) return false;
  return true;
}

/** Whether `isServerFile` needs the file's head to decide. */
export const needsHead = (path: string) => (path.endsWith(".tsx") || path.endsWith(".jsx")) && !NEXT_SERVER.test(path);

/** Server files of a listing, in listing order. `read` returns the file text (undefined when unreadable). */
export async function serverFiles(files: string[], read: (file: string) => Promise<string | undefined>): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    if (!f) continue;
    if (needsHead(f) && isServerFile(f, "use server")) {
      const text = await read(f).catch(() => undefined);
      if (text === undefined || !isServerFile(f, text.slice(0, 200))) continue;
      out.push(f);
    } else if (isServerFile(f)) out.push(f);
  }
  return out;
}

const count = (re: RegExp, text: string) => text.match(re)?.length ?? 0;

/** Newline count, at least 1: the line count the risk density and whole-file chunks use. */
export const newlineCount = (text: string) => Math.max(1, count(/\n/g, text));

/** Lines as a line-by-line read counts them: a last line without a newline still counts. */
export const lineCount = (text: string) => count(/\n/g, text) + (text && !text.endsWith("\n") ? 1 : 0);

/** Risk density of one file: the stronger of the web and native families (native only for native sources). */
export function riskScore(path: string, text: string): { density: number; lines: number } {
  const n = newlineCount(text);
  const web = count(WEB_WORDS, text) / n;
  const native = NATIVE_EXT.test(path) ? (count(NATIVE_WORDS, text) / n) * 3 : 0;
  return { density: Math.max(web, native), lines: n };
}
