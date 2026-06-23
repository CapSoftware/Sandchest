/* eslint-disable @next/next/no-img-element */
import type { Metadata } from "next";
import Link from "next/link";
import {
  JetBrains_Mono,
  IBM_Plex_Mono,
  Space_Mono,
  Space_Grotesk,
  Bricolage_Grotesque,
  Sora,
  Outfit,
  Familjen_Grotesk,
  Syne,
  Instrument_Serif,
  Fraunces,
} from "next/font/google";

/* ---- type specimens ---------------------------------------------------------
   One face per candidate, each instantiated as a CSS variable so a wordmark can
   opt into it inline. Geist Mono (the current UI face) is already on <html> from
   the root layout, so it needs no import here. ------------------------------ */
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });
const plex = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex", display: "swap" });
const spaceMono = Space_Mono({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-space-mono", display: "swap" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap" });
const familjen = Familjen_Grotesk({ subsets: ["latin"], variable: "--font-familjen", display: "swap" });
const syne = Syne({ subsets: ["latin"], variable: "--font-syne", display: "swap" });
const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });

const fontVars = [
  jetbrains.variable,
  plex.variable,
  spaceMono.variable,
  spaceGrotesk.variable,
  bricolage.variable,
  sora.variable,
  outfit.variable,
  familjen.variable,
  syne.variable,
  instrument.variable,
  fraunces.variable,
].join(" ");

export const metadata: Metadata = {
  title: "Identity lab",
  description: "Wordmark explorations for Sandchest — one icon, many faces.",
  robots: { index: false, follow: false },
};

/* The icon is settled: the chest we already ship. Every lockup below pairs it
   with a different face for the word — capital S, the rest lowercase. */
const ICON_SRC = "/sandchest-icon.svg";

type Face = {
  no: string;
  font: string;
  name: string;
  note: string;
  weight: number;
  serif?: boolean;
};

// each row is a real candidate face for the "Sandchest" wordmark
const FACES: Face[] = [
  { no: "01", font: "var(--font-geist-mono)", name: "Geist Mono", note: "Your current UI face — the baseline", weight: 600 },
  { no: "02", font: "var(--font-jetbrains)", name: "JetBrains Mono", note: "Dev-native, very even color", weight: 600 },
  { no: "03", font: "var(--font-plex)", name: "IBM Plex Mono", note: "Humanist mono, a touch warmer", weight: 500 },
  { no: "04", font: "var(--font-space-mono)", name: "Space Mono", note: "Retro-terminal quirk in the a, t, g", weight: 700 },
  { no: "05", font: "var(--font-space-grotesk)", name: "Space Grotesk", note: "Techy grotesque, tight and current", weight: 600 },
  { no: "06", font: "var(--font-bricolage)", name: "Bricolage Grotesque", note: "Display warmth, friendly and human", weight: 600 },
  { no: "07", font: "var(--font-sora)", name: "Sora", note: "Geometric, neutral-modern", weight: 600 },
  { no: "08", font: "var(--font-outfit)", name: "Outfit", note: "Rounded geometric, soft and light", weight: 500 },
  { no: "09", font: "var(--font-familjen)", name: "Familjen Grotesk", note: "Clean Nordic grotesque", weight: 600 },
  { no: "10", font: "var(--font-syne)", name: "Syne", note: "Quirky display — the loud option", weight: 700 },
  { no: "11", font: "var(--font-instrument)", name: "Instrument Serif", note: "Editorial serif — unexpected contrast", weight: 400, serif: true },
  { no: "12", font: "var(--font-fraunces)", name: "Fraunces", note: "Soft serif, sandy warmth", weight: 500, serif: true },
];

// the two faces to read as "this is the logo" first
const FEATURED = ["05", "01"];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs uppercase tracking-[0.28em] text-faint">{children}</span>
  );
}

function SectionHead({ index, title, blurb }: { index: string; title: string; blurb: string }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line pb-6">
      <div className="flex items-baseline gap-3">
        <span className="text-sm text-accent">{index}</span>
        <Eyebrow>{title}</Eyebrow>
      </div>
      <p className="max-w-[52ch] text-sm text-muted">{blurb}</p>
    </div>
  );
}

/* the existing chest icon, served straight from /public so it stays pixel-for-
   pixel the mark we already ship */
function Icon({ className }: { className?: string }) {
  return <img src={ICON_SRC} alt="" className={className} />;
}

/* the wordmark — capital S, the rest lowercase. Optionally split Sand|chest by
   weight so the compound reads without a second color. */
function WordMark({
  font,
  weight,
  twoTone,
  className,
  softClass = "text-muted",
}: {
  font: string;
  weight: number;
  twoTone?: boolean;
  className?: string;
  softClass?: string;
}) {
  if (twoTone) {
    return (
      <span style={{ fontFamily: font }} className={className}>
        <span style={{ fontWeight: 700 }}>Sand</span>
        <span style={{ fontWeight: 300 }} className={softClass}>
          chest
        </span>
      </span>
    );
  }
  return (
    <span style={{ fontFamily: font, fontWeight: weight }} className={className}>
      Sandchest
    </span>
  );
}

export default function DesignPage() {
  const featured = FACES.filter((f) => FEATURED.includes(f.no));
  return (
    <div className={`${fontVars} min-h-dvh bg-bg`}>
      {/* header */}
      <header className="mx-auto flex w-full max-w-[80rem] items-center justify-between px-6 py-6 md:px-10">
        <Link href="/" className="focusable flex items-center gap-2 text-sm text-muted hover:text-fg">
          <span aria-hidden>&larr;</span> Back to site
        </Link>
        <div className="flex items-center gap-2 text-sm text-faint">
          <Icon className="h-5 w-auto" />
          <span>identity lab</span>
        </div>
      </header>

      {/* hero — the thesis: icon is settled, the word is up for grabs */}
      <section className="mx-auto w-full max-w-[80rem] px-6 pb-14 pt-10 md:px-10 md:pb-20 md:pt-16">
        <Eyebrow>Sandchest / wordmark</Eyebrow>
        <h1 className="mt-5 max-w-[20ch] text-balance text-[2.4rem] font-bold leading-[1.04] tracking-tight text-fg md:text-[3.4rem]">
          One chest.
          <br />
          Twelve voices.
        </h1>
        <p className="mt-6 max-w-[58ch] text-fg-soft">
          The icon is settled — the chest we already ship, kept exactly as it is.
          What&rsquo;s left is the word beside it. Every lockup below sets{" "}
          <span className="text-fg">Sandchest</span> — capital S, the rest
          lowercase — in a different face. Skim it, then tell me which numbers to
          push.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted">
          <span>1 icon</span>
          <span aria-hidden className="text-faint">/</span>
          <span>12 faces</span>
          <span aria-hidden className="text-faint">/</span>
          <span>6 treatments</span>
          <span aria-hidden className="text-faint">/</span>
          <span>in context</span>
        </div>
      </section>

      {/* A — the icon we're keeping */}
      <section className="mx-auto w-full max-w-[80rem] px-6 md:px-10">
        <SectionHead
          index="A"
          title="The icon (fixed)"
          blurb="No changes here — this is the chest we already ship. It's the constant in every lockup below, on dark and on sand."
        />
        <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
          <div className="flex items-center justify-center bg-surface/40 py-16">
            <Icon className="h-28 w-auto" />
          </div>
          <div className="flex items-center justify-center bg-[#ece3d2] py-16">
            <Icon className="h-28 w-auto" />
          </div>
        </div>
      </section>

      {/* B — featured lockups */}
      <section className="mx-auto mt-20 w-full max-w-[80rem] px-6 md:mt-28 md:px-10">
        <SectionHead
          index="B"
          title="Front-runners"
          blurb="The two pairings I'd ship today — the current mono baseline, and a tighter grotesque. Same icon, capital-S word."
        />
        <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-2">
          {featured.map((f) => (
            <div key={f.no} className="flex flex-col items-center justify-center gap-4 bg-surface/40 px-6 py-16">
              <div className="flex items-center gap-4">
                <Icon className="h-12 w-auto shrink-0" />
                <WordMark font={f.font} weight={f.weight} className="text-fg text-[2.3rem] tracking-tight md:text-[2.7rem]" />
              </div>
              <span className="text-xs text-faint">
                {f.no} · {f.name}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* C — every face */}
      <section className="mx-auto mt-20 w-full max-w-[80rem] px-6 md:mt-28 md:px-10">
        <SectionHead
          index="C"
          title="The icon + every face"
          blurb="The same chest assembled with twelve faces for the word — monospace (on-brand for a dev tool), grotesque, geometric, and a couple of serifs for contrast."
        />
        <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {FACES.map((f) => (
            <figure key={f.no} className="flex flex-col bg-bg">
              <div className="flex flex-1 items-center justify-center gap-3 bg-surface/40 px-5 py-11">
                <Icon className="h-9 w-auto shrink-0" />
                <WordMark font={f.font} weight={f.weight} className="text-fg text-[1.5rem] tracking-tight" />
              </div>
              <figcaption className="flex items-start gap-2.5 border-t border-line px-4 py-3.5">
                <span className="text-xs text-accent">{f.no}</span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm text-fg">{f.name}</span>
                  <span className="text-xs leading-relaxed text-muted">{f.note}</span>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* D — wordmark treatments */}
      <section className="mx-auto mt-20 w-full max-w-[80rem] px-6 md:mt-28 md:px-10">
        <SectionHead
          index="D"
          title="Treatments"
          blurb="Once a face is chosen, these are the levers on the word itself — splitting the compound, shifting weight across Sand|chest, or leaning into the terminal. Shown in Space Grotesk."
        />
        <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          <Treatment label="Two-tone weight" note="Reveal the compound with weight, not a color">
            <span style={{ fontFamily: "var(--font-space-grotesk)" }}>
              <span style={{ fontWeight: 700 }}>Sand</span>
              <span style={{ fontWeight: 300 }} className="text-fg-soft">
                chest
              </span>
            </span>
          </Treatment>
          <Treatment label="Caps, tracked" note="Quieter, more utility-belt / wordmark-as-label">
            <span style={{ fontFamily: "var(--font-space-grotesk)", fontWeight: 500, letterSpacing: "0.18em" }}>
              SANDCHEST
            </span>
          </Treatment>
          <Treatment label="Seam" note="A gold dot marks the join of the two words">
            <span style={{ fontFamily: "var(--font-space-grotesk)", fontWeight: 600 }}>
              Sand<span className="text-accent">·</span>chest
            </span>
          </Treatment>
          <Treatment label="Prompt" note="A cursor block — leans into the sandbox/terminal idea">
            <span style={{ fontFamily: "var(--font-space-mono)", fontWeight: 700 }}>
              Sandchest<span className="ml-1 inline-block h-[0.9em] w-[0.42em] translate-y-[0.06em] bg-accent align-baseline" />
            </span>
          </Treatment>
          <Treatment label="Stacked" note="For square spaces — app icons, social avatars">
            <span
              style={{ fontFamily: "var(--font-space-grotesk)", fontWeight: 700, lineHeight: 0.92 }}
              className="flex flex-col"
            >
              <span>Sand</span>
              <span className="text-fg-soft">chest</span>
            </span>
          </Treatment>
          <Treatment label="Lined" note="Underscore baseline — a drawer pulling open">
            <span
              style={{ fontFamily: "var(--font-space-grotesk)", fontWeight: 600 }}
              className="border-b-2 border-accent pb-1.5"
            >
              Sandchest
            </span>
          </Treatment>
        </div>
      </section>

      {/* E — in context */}
      <section className="mx-auto mt-20 w-full max-w-[80rem] px-6 pb-8 md:mt-28 md:px-10">
        <SectionHead
          index="E"
          title="In context"
          blurb="The same lockup where it actually lives — sitting in the site header, across a few of the strongest faces."
        />
        <div className="mt-8 flex flex-col gap-4">
          {FACES.filter((f) => ["05", "01", "06"].includes(f.no)).map((f) => (
            <NavbarMock key={f.no} face={f} />
          ))}
        </div>
      </section>

      <footer className="mx-auto w-full max-w-[80rem] px-6 py-12 md:px-10">
        <p className="border-t border-line pt-6 text-sm text-muted">
          Reference anything by its number — &ldquo;ship C-05&rdquo; works.
          Nothing here is wired into the live site.
        </p>
      </footer>
    </div>
  );
}

function Treatment({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <figure className="flex flex-col bg-bg">
      <div className="flex flex-1 items-center justify-center bg-surface/40 px-6 py-14 text-[1.9rem] text-fg">
        {children}
      </div>
      <figcaption className="flex flex-col gap-0.5 border-t border-line px-5 py-4">
        <span className="text-sm text-fg-soft">{label}</span>
        <span className="text-xs text-muted">{note}</span>
      </figcaption>
    </figure>
  );
}

/* the lockup sitting in the real site header */
function NavbarMock({ face }: { face: Face }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center justify-between border-b border-line bg-bg px-5 py-4 md:px-6">
        <span className="flex items-center gap-2.5">
          <Icon className="h-6 w-auto shrink-0" />
          <WordMark font={face.font} weight={face.weight} className="text-fg text-[1.05rem] tracking-tight" />
        </span>
        <nav className="flex items-center gap-4 text-xs text-muted sm:gap-5">
          <span className="hidden sm:inline">GitHub</span>
          <span className="hidden sm:inline">Pricing</span>
          <span className="hidden sm:inline">FAQ</span>
        </nav>
      </div>
      <div className="bg-surface/30 px-5 py-3 text-xs text-faint md:px-6">
        {face.no} · {face.name}
      </div>
    </div>
  );
}
