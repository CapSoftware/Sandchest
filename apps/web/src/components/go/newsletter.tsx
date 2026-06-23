export function Newsletter() {
  return (
    <section className="gutter border-t border-line py-16 md:py-20">
      <h2 className="text-2xl font-semibold tracking-[-0.01em] text-fg md:text-3xl">
        Be the first to know when we ship new models
      </h2>
      <p className="mt-4 max-w-[42rem] text-fg-soft">
        Join the waitlist for early access, new open coding models and product
        updates.
      </p>

      <div className="mt-6 flex w-full max-w-md items-center gap-2">
        <input
          type="email"
          aria-label="Email address"
          placeholder="Email address"
          className="focusable h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-muted"
        />
        <button
          type="button"
          className="focusable h-10 shrink-0 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
        >
          Subscribe
        </button>
      </div>
    </section>
  );
}
