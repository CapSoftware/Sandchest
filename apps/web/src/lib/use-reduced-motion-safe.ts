"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

export function useReducedMotionSafe() {
  const prefersReduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && !!prefersReduced;
}
