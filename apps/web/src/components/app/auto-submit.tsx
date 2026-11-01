"use client";
import type { ComponentProps } from "react";

/** A select that submits its GET form on change; the form's button covers no-JS. */
export function AutoSubmitSelect(props: ComponentProps<"select">) {
  return <select {...props} onChange={(event) => event.currentTarget.form?.requestSubmit()} />;
}
