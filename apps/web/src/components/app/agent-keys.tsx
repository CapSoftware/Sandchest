"use client";
import { useActionState } from "react";
import { createKey, type KeyOutcome } from "@/server/key-actions";
import { CopyText } from "./copy-text";
import { Submit } from "./submit";

/** Creates an API key and shows it, once. */
export function CreateKeyForm() {
  const [state, action] = useActionState<KeyOutcome, FormData>(createKey, {});
  if (state.key) {
    return (
      <div className="agent-new-key">
        <p className="field-help">Your new key. It won’t be shown again: give it to your agent or store it as SANDCHEST_API_KEY.</p>
        <pre className="poc setup-env">{state.key}</pre>
        <div className="setup-copy">
          <CopyText text={state.key} label="Copy key" />
        </div>
      </div>
    );
  }
  return (
    <form action={action} className="inline-form">
      <label className="text-field">
        <span className="text-field-label">Name</span>
        <input name="name" maxLength={80} placeholder="CI, my laptop…" autoComplete="off" />
      </label>
      <Submit className="key key-secondary" pending="Creating…" track="api-key-create">
        Create API key
      </Submit>
      {state.error && <span role="alert" data-error="">{state.error}</span>}
    </form>
  );
}
