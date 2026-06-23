export const BASE_URL = "https://api.sandchest.com/v1";

export const navLinks = [
  { label: "Models", href: "#models" },
  { label: "Usage", href: "#usage" },
  { label: "Pricing", href: "#pricing" },
  { label: "Status", href: "#status" },
] as const;

export type Accent = "accent" | "neutral" | "emerald";

export type Model = {
  id: string;
  name: string;
  badge: string;
  accent: Accent;
  description: string;
  usageProfile: string;
  /** 0-100 relative usage pressure used for the meter visual */
  burn: number;
  bestFor: string[];
  doodle: "chest" | "bug" | "compass";
};

export const models: Model[] = [
  {
    id: "sandchest/glm-5.2",
    name: "GLM-5.2",
    badge: "Premium",
    accent: "accent",
    description:
      "Our first premium coding model. Strong agentic coding performance, large context, and great for serious codebase work.",
    usageProfile: "Premium capacity",
    burn: 100,
    bestFor: [
      "Hard coding tasks",
      "Larger codebase context",
      "Agentic edits",
      "Planning and implementation",
    ],
    doodle: "chest",
  },
  {
    id: "sandchest/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    badge: "High volume",
    accent: "neutral",
    description:
      "A fast, efficient model for high-volume coding-agent loops. Great for long sessions and quick iterations.",
    usageProfile: "High-volume friendly",
    burn: 28,
    bestFor: [
      "Routine edits",
      "Fast iterations",
      "Long sessions",
      "Cheap agent loops",
    ],
    doodle: "bug",
  },
  {
    id: "sandchest/minimax-m3",
    name: "MiniMax M3",
    badge: "Balanced",
    accent: "neutral",
    description:
      "A balanced open model for everyday coding, debugging and refactoring.",
    usageProfile: "Balanced usage",
    burn: 60,
    bestFor: [
      "Daily coding",
      "Debugging",
      "Refactoring",
      "Medium complexity tasks",
    ],
    doodle: "compass",
  },
];

/** Model lineup shown in the benchmark chart on the landing page. */
export type LineupModel = {
  name: string;
  vendor: string;
  status: "live" | "soon";
  /** SWE-bench Verified (%). Present only for live, benchmarked models. */
  score?: number;
};

// TODO: replace with verified benchmark numbers as each model ships.
export const lineup: LineupModel[] = [
  {
    name: "GLM-5.2",
    vendor: "Zhipu AI",
    status: "live",
    score: 73,
  },
  {
    name: "Kimi K2.7",
    vendor: "Moonshot AI",
    status: "soon",
  },
  {
    name: "MiniMax M3",
    vendor: "MiniMax",
    status: "soon",
  },
];

/** Indicative closed-frontier average, drawn as a reference line in the chart. */
export const frontierScore = 75;

export type Tool = {
  name: string;
  blurb: string;
  glyph: string;
};

export const tools: Tool[] = [
  { name: "OpenCode", blurb: "Native provider config", glyph: "[]" },
  { name: "Claude Code", blurb: "Anthropic base URL", glyph: "{}" },
  { name: "Cline", blurb: "Custom OpenAI endpoint", glyph: "</>" },
  { name: "Roo Code", blurb: "Custom OpenAI endpoint", glyph: "//" },
  { name: "Aider", blurb: "OpenAI-compatible", glyph: "::" },
  { name: "Continue", blurb: "Model provider block", glyph: "->" },
  { name: "Cursor-compatible", blurb: "Custom model workflows", glyph: "^" },
  { name: "OpenAI-compatible", blurb: "Any /v1 client", glyph: "*" },
  { name: "Anthropic-compatible", blurb: "Any /messages client", glyph: "~" },
];

/** The one plan. Flat price, every model, all you can eat within fair-use limits. */
export const chestPlan = {
  name: "Founding Plan",
  price: 149,
  cadence: "/month",
  includes: [
    "A growing lineup of open coding models, all on the same key",
    "Use it in any agent: Claude Code, Cursor, Codex, OpenCode and more",
    "One key and one base URL, OpenAI- and Anthropic-compatible",
    "All-you-can-eat coding within fair-use limits",
    "Founder price locked for 12 months",
    "Cancel whenever you like",
  ],
} as const;

export type FaqItem = { q: string; a: string };

export const faqs: FaqItem[] = [
  {
    q: "What is Sandchest?",
    a: "Sandchest is open source and hosts a growing lineup of open coding models behind one API key and one base URL. You point the agent you already use at it, then pay one flat monthly price with no per-token API bills.",
  },
  {
    q: "Is it really all you can eat?",
    a: "All you can eat in the way that matters: no token meters, no per-request charges, no invoice that balloons at the end of the month. There are fair-use limits running quietly in the background to keep capacity fast for everyone, and they're set with everyday coding in mind so most day-to-day work stays comfortably inside them.",
  },
  {
    q: "What counts as fair use?",
    a: "Fair use exists to stop a handful of extreme cases, like reselling access or pinning the service at full tilt around the clock, from slowing things down for everyone else. If you're a developer coding with an agent all day, you're comfortably inside it, and we'll always reach out before doing anything.",
  },
  {
    q: "Is this just an API wrapper?",
    a: "No. Sandchest gives you reliable capacity tuned for coding agents, a flat predictable price, and one endpoint that works across every major coding tool. Over time we're adding dedicated capacity and more coding-specific features on top.",
  },
  {
    q: "Which agents does it work with?",
    a: "Anything that lets you set a custom OpenAI- or Anthropic-compatible endpoint: Claude Code, Cursor, Codex, OpenCode, Cline, Aider, Continue, your own scripts, all on the same key and base URL.",
  },
  {
    q: "Can I use GLM-5.2?",
    a: "Yes. GLM-5.2 is one of the open coding models Sandchest supports, and we're adding more models under the same key.",
  },
  {
    q: "How much does it cost?",
    a: "One plan: $149/month, all you can eat within fair-use limits. No tiers to compare, no token math, no surprise usage bill. Founders lock that price for 12 months.",
  },
  {
    q: "Is Sandchest private?",
    a: "During beta, Sandchest avoids storing prompts and completions by default. Some upstream providers may process requests depending on the model and routing. Full privacy details live in the docs.",
  },
];

export const footerColumns = [
  {
    title: "Product",
    links: [
      { label: "Models", href: "#models" },
      { label: "Usage", href: "#usage" },
      { label: "Pricing", href: "#pricing" },
      { label: "Status", href: "#status" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Changelog", href: "#" },
      { label: "Contact", href: "#" },
      { label: "Terms", href: "#" },
      { label: "Privacy", href: "#" },
    ],
  },
] as const;

/** The one endpoint everything points at. */
export const connection = {
  baseUrl: BASE_URL,
  model: "glm-5.2",
  apiKey: "sk-sc-••••••••••••••••",
} as const;

export const howItWorks = [
  {
    step: "01",
    title: "Grab your key",
    body: "Subscribe and copy your Sandchest key from the dashboard. One key works everywhere.",
  },
  {
    step: "02",
    title: "Point your agent",
    body: "Drop the Sandchest base URL and key into any OpenAI- or Anthropic-compatible agent.",
  },
  {
    step: "03",
    title: "Code without the meter",
    body: "Run Claude Code, Cursor, OpenCode or your own scripts across open coding models, all you can eat within fair-use limits.",
  },
] as const;
