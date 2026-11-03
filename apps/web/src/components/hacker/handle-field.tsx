"use client";
import type { RefObject } from "react";
import { HANDLE_MAX, rollHandle, validHandle, type HackerProfile } from "@/lib/hacker";

/** The hacker's name, in the screen's colour and a block caret, with dice to roll one. */
export function HandleField({
  id,
  inputRef,
  profile,
  update,
  onFocus,
  onDown,
}: {
  id: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  profile: HackerProfile;
  update: (patch: Partial<HackerProfile>) => void;
  onFocus?: () => void;
  /** ↓ out of the field, into whatever is under it. */
  onDown?: () => void;
}) {
  return (
    <div className="onboard-name">
      <input
        id={id}
        ref={inputRef}
        value={profile.handle}
        onChange={(event) => update({ handle: event.target.value.slice(0, HANDLE_MAX) })}
        onFocus={onFocus}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && onDown) {
            event.preventDefault();
            onDown();
          }
        }}
        maxLength={HANDLE_MAX}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!validHandle(profile.handle) || undefined}
        aria-describedby="handle-help"
      />
      <button type="button" onClick={() => update({ handle: rollHandle(profile.handle) })}>
        <Dice /> Roll
      </button>
    </div>
  );
}

function Dice() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" aria-hidden="true" shapeRendering="crispEdges">
      <path fill="currentColor" d="M0 0h7v7H0zM1 1v5h5V1zM2 2h1v1H2zM4 4h1v1H4zM3 3h1v1H3z" fillRule="evenodd" />
    </svg>
  );
}
