import Image from "next/image";
import Link from "next/link";

const nav = [
  { label: "GitHub", href: "#" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

export function Header() {
  return (
    <header className="gutter flex items-center justify-between py-5">
      <Link href="/" className="flex items-center focusable" aria-label="Sandchest home">
        <Image
          src="/sandchest-logo-dark.svg"
          alt="Sandchest"
          width={2382}
          height={473}
          priority
          className="h-7 w-auto"
        />
      </Link>

      <nav className="hidden items-center gap-6 text-sm sm:flex">
        {nav.map((item) => (
          <a key={item.label} href={item.href} className="link-muted font-medium">
            {item.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
