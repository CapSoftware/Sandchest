"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { CodeWindow, Tok } from "@/components/code-window";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { cn } from "@/lib/utils";

type TabKey = "opencode" | "claude" | "openai";

const tabs: { key: TabKey; label: string; file: string; tag: string }[] = [
  { key: "opencode", label: "OpenCode", file: "opencode.json", tag: "json" },
  { key: "claude", label: "Claude Code", file: ".env", tag: "bash" },
  { key: "openai", label: "OpenAI-compatible", file: "client.ts", tag: "ts" },
];

const copyValues: Record<TabKey, string> = {
  opencode: `{
  "provider": "sandchest",
  "baseURL": "https://api.sandchest.com/v1",
  "model": "sandchest/glm-5.2"
}`,
  claude: `ANTHROPIC_BASE_URL=https://api.sandchest.com
ANTHROPIC_AUTH_TOKEN=sk-sand_...`,
  openai: `const client = new OpenAI({
  apiKey: process.env.SANDCHEST_API_KEY,
  baseURL: "https://api.sandchest.com/v1"
})`,
};

function Snippet({ tab }: { tab: TabKey }) {
  if (tab === "opencode") {
    return (
      <pre>
        {"{\n"}
        {"  "}
        <Tok.key>&quot;provider&quot;</Tok.key>: <Tok.str>&quot;sandchest&quot;</Tok.str>,{"\n"}
        {"  "}
        <Tok.key>&quot;baseURL&quot;</Tok.key>:{" "}
        <Tok.str>&quot;https://api.sandchest.com/v1&quot;</Tok.str>,{"\n"}
        {"  "}
        <Tok.key>&quot;model&quot;</Tok.key>:{" "}
        <Tok.str>&quot;sandchest/glm-5.2&quot;</Tok.str>
        {"\n}"}
      </pre>
    );
  }
  if (tab === "claude") {
    return (
      <pre>
        <Tok.flag>ANTHROPIC_BASE_URL</Tok.flag>=
        <Tok.str>https://api.sandchest.com</Tok.str>
        {"\n"}
        <Tok.flag>ANTHROPIC_AUTH_TOKEN</Tok.flag>=<Tok.str>sk-sand_...</Tok.str>
        {"\n\n"}
        <Tok.dim># point Claude Code at Sandchest, keep your agent setup</Tok.dim>
      </pre>
    );
  }
  return (
    <pre>
      <Tok.cmd>const</Tok.cmd> client = <Tok.cmd>new</Tok.cmd>{" "}
      <Tok.fn>OpenAI</Tok.fn>({"{"}
      {"\n"}
      {"  "}apiKey: process.<Tok.fn>env</Tok.fn>.SANDCHEST_API_KEY,{"\n"}
      {"  "}baseURL: <Tok.str>&quot;https://api.sandchest.com/v1&quot;</Tok.str>
      {"\n"}
      {"})"}
    </pre>
  );
}

export function ProductDemo() {
  const [active, setActive] = useState<TabKey>("opencode");
  const current = tabs.find((t) => t.key === active)!;

  return (
    <section className="container-page py-20 sm:py-24">
      <SectionHeading
        eyebrow="Drop-in setup"
        title="Drop Sandchest into your existing coding setup."
        description="It is just an API key and a base URL. Keep your editor, keep your agent, change one endpoint."
      />

      <Reveal delay={0.1} className="mt-10">
        <div className="panel overflow-hidden">
          {/* tab strip */}
          <div
            role="tablist"
            aria-label="Setup examples"
            className="flex flex-wrap gap-1 border-b border-line p-2"
          >
            {tabs.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={active === tab.key}
                onClick={() => setActive(tab.key)}
                className={cn(
                  "focusable relative rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
                  active === tab.key
                    ? "text-fg"
                    : "text-muted hover:text-fg-soft",
                )}
              >
                {active === tab.key ? (
                  <motion.span
                    layoutId="demo-tab"
                    className="absolute inset-0 rounded-lg border border-line-strong bg-white/[0.05]"
                    transition={{ type: "spring", stiffness: 400, damping: 32 }}
                  />
                ) : null}
                <span className="relative">{tab.label}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-0 lg:grid-cols-[1.4fr_1fr]">
            <div className="border-b border-line p-4 lg:border-b-0 lg:border-r">
              <CodeWindow
                title={current.file}
                tag={current.tag}
                copyValue={copyValues[active]}
                className="border-line/80"
              >
                <motion.div
                  key={active}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <Snippet tab={active} />
                </motion.div>
              </CodeWindow>
            </div>

            <div className="flex flex-col justify-center gap-4 p-6">
              <p className="font-mono text-xs uppercase tracking-wide text-accent">
                {current.label}
              </p>
              <p className="text-[1.05rem] text-fg">
                Paste one base URL into your coding agent and get moving.
              </p>
              <ul className="flex flex-col gap-2 text-sm text-muted">
                <li className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-accent" />
                  Works with OpenAI and Anthropic-style endpoints
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-accent" />
                  Switch models without changing your tool
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-accent" />
                  Same key across every agent you use
                </li>
              </ul>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
