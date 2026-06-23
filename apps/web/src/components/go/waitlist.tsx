"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { WaitlistModal } from "./waitlist-modal";

/* One waitlist dialog for the whole site. Mounted once at the root; any button
   (the hero key, the pricing CTA, …) opens it through `useWaitlist()`, so the
   modal state isn't trapped inside a single section. */

type WaitlistContextValue = {
  open: boolean;
  openWaitlist: () => void;
  closeWaitlist: () => void;
};

const WaitlistContext = createContext<WaitlistContextValue | null>(null);

export function WaitlistProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openWaitlist = useCallback(() => setOpen(true), []);
  const closeWaitlist = useCallback(() => setOpen(false), []);
  const value = useMemo(
    () => ({ open, openWaitlist, closeWaitlist }),
    [open, openWaitlist, closeWaitlist],
  );

  return (
    <WaitlistContext.Provider value={value}>
      {children}
      <WaitlistModal open={open} onClose={closeWaitlist} />
    </WaitlistContext.Provider>
  );
}

// Falls back to no-ops if used outside a provider, so a stray ChestButton never
// throws (it just won't open anything).
export function useWaitlist(): WaitlistContextValue {
  return (
    useContext(WaitlistContext) ?? {
      open: false,
      openWaitlist: () => {},
      closeWaitlist: () => {},
    }
  );
}
