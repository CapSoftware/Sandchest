import type { ReactNode } from "react";

export function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="gutter border-t border-line py-16 md:py-20">
      <h2 className="text-2xl font-semibold tracking-[-0.01em] text-fg md:text-3xl">
        {title}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}
