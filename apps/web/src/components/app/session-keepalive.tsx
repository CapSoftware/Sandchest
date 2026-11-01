"use client";
import { useEffect } from "react";

/**
 * Extends the session while it is used. Pages read the session without
 * better-auth and can't set cookies, so when a session is a day old the
 * browser asks better-auth's own endpoint, which pushes back the expiry and
 * re-issues the cookie. Rendered only when due: about once a day.
 */
export function SessionKeepAlive() {
  useEffect(() => {
    void fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" }).catch(() => {});
  }, []);
  return null;
}
