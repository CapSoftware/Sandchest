"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { navLinks } from "@/lib/data";
import { Logo } from "@/components/doodles";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b transition-colors duration-300",
        scrolled
          ? "border-line bg-ink/80 backdrop-blur-xl"
          : "border-transparent",
      )}
    >
      <div className="container-page">
        <nav className="flex h-14 items-center justify-between">
          <Link href="/" className="focusable rounded-lg" aria-label="Sandchest home">
            <Logo className="h-8" />
          </Link>

          <div className="hidden items-center gap-7 md:flex">
            {navLinks.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="focusable rounded text-[0.9rem] text-fg-soft transition-colors hover:text-fg"
              >
                {link.label}
              </Link>
            ))}
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <Button href="#pricing" variant="primary" size="sm">
              Get early access
            </Button>
          </div>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="focusable grid h-10 w-10 place-items-center rounded-lg text-fg-soft hover:text-fg md:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </nav>
      </div>

      {open ? (
        <div className="fixed inset-x-0 top-14 bottom-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-ink/70 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="container-page relative">
            <div className="panel mt-2 flex flex-col gap-1 p-3">
              {navLinks.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="focusable rounded-lg px-3 py-3 text-base text-fg-soft hover:bg-white/[0.04] hover:text-fg"
                >
                  {link.label}
                </Link>
              ))}
              <div className="mt-2">
                <Button
                  href="#pricing"
                  variant="primary"
                  size="md"
                  className="w-full"
                  onClick={() => setOpen(false)}
                >
                  Get early access
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
