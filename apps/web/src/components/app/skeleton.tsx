"use client";

import type { ComponentProps, ReactNode } from "react";
import { forgetShapes, type SkulletTheme } from "skullet";
import { Skeleton, SkulletProvider } from "skullet/react";

/**
 * Loading skeletons, drawn by skullet: each page's loading state is its own
 * layout measured into bars, so nothing moves when the data arrives.
 *
 * A page wraps what it renders in `PageShape`, which remembers its shape under
 * an id. Its `loading.tsx` renders `PageSkeleton` with the same id and a
 * sample of the page: the first visit is drawn from the sample, every later
 * one from the page as it last stood (layout only, never its text).
 */

/** The seam colour the chest is drawn with, pulsing like the rest of the site. Square, as every edge here is. */
const THEME: SkulletTheme = {
  dark: { base: "#2c2219", highlight: "rgb(255 243 220 / 0.06)" },
  animation: "pulse",
  speed: "fast",
  radius: "0",
};

/** Skullet's settings for the app and the operator dashboards. The site is dark only. */
export function Skeletons({ children }: { children: ReactNode }) {
  return (
    <SkulletProvider mode="dark" theme={THEME}>
      {children}
    </SkulletProvider>
  );
}

/** A page's content, whose shape is remembered under `id` for its next skeleton. */
export function PageShape({ id, children }: { id: string; children: ReactNode }) {
  return <Skeleton id={id}>{children}</Skeleton>;
}

/** A page's loading state: the shape last remembered under `id`, or `children` (a sample of the page) measured into one. */
export function PageSkeleton({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <Skeleton loading id={id} label={label}>
      {children}
    </Skeleton>
  );
}

/** A form that forgets every remembered shape as it submits, so the next person on this browser sees none of them. */
export function ForgetShapesForm(props: ComponentProps<"form">) {
  return (
    <form
      {...props}
      onSubmit={(event) => {
        forgetShapes();
        props.onSubmit?.(event);
      }}
    />
  );
}
