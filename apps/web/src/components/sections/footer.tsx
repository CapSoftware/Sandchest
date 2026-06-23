import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo, ChestLine } from "@/components/doodles";
import { Reveal } from "@/components/reveal";
import { footerColumns } from "@/lib/data";

export function Footer() {
  return (
    <footer className="relative mt-8">
      <div className="container-page">
        <Reveal>
          <div className="panel flex flex-col items-center px-6 py-16 text-center sm:py-20">
            <ChestLine className="h-16 w-16 text-fg-soft" />
            <h2 className="mt-6 max-w-2xl text-balance text-[1.75rem] leading-tight text-fg sm:text-[2.25rem]">
              One key. Multiple coding models. Predictable usage.
            </h2>
            <p className="mt-4 max-w-lg text-pretty text-muted">
              Built for developers who use coding agents every day. Start with
              GLM-5.2. More models coming next.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button href="#pricing" size="lg" className="group">
                Join the beta
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Button>
            </div>
          </div>
        </Reveal>

        <div className="mt-16 grid gap-10 pb-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-4">
            <Logo />
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              A subscription gateway for open coding models. One key, one plan,
              no surprise bills.
            </p>
          </div>

          {footerColumns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <p className="font-mono text-xs uppercase tracking-wide text-faint">
                {column.title}
              </p>
              <ul className="mt-4 flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="focusable rounded text-sm text-fg-soft transition-colors hover:text-fg"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="rule-x" />

        <div className="flex flex-col items-center justify-between gap-3 py-7 sm:flex-row">
          <p className="text-sm text-faint">
            Sandchest — open coding models, boxed up neatly.
          </p>
          <p className="font-mono text-xs text-faint">
            © {new Date().getFullYear()} Sandchest. Beta.
          </p>
        </div>
      </div>
    </footer>
  );
}
