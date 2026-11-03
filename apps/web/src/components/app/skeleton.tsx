"use client";

import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { forgetShapes, type SkulletTheme } from "skullet";
import { Skeleton, SkulletProvider } from "skullet/react";

/**
 * Loading skeletons, drawn by skullet: each page's loading state is its own
 * layout measured into bars, so nothing moves when the data arrives.
 *
 * A page wraps what it renders in `PageShape`, which remembers its shape under
 * an id. Its `loading.tsx` renders `PageSkeleton` with the same id and the
 * page's own view drawn from sample data, so the two can't drift apart: the
 * first visit is drawn from the sample, every later one from the page as it
 * last stood (layout only, never its text).
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

const InSkeleton = createContext(false);

/** True inside a loading state's sample: live parts (a 3D scene, a feed) draw only their outline there, and start nothing. */
export function useInSkeleton(): boolean {
  return useContext(InSkeleton);
}

/** A page's loading state: the shape last remembered under `id`, or `children` (the page's view of sample data) measured into one. */
export function PageSkeleton({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <InSkeleton.Provider value>
      <Skeleton loading id={id} label={label}>
        {children}
      </Skeleton>
    </InSkeleton.Provider>
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
