import { queryOne } from "./db";

export interface UserSettings {
  theme: "light" | "dark" | "system";
  locale: string;
  notifications: { email: boolean; invoicePaid: boolean; weeklySummary: boolean };
  invoiceDefaults: { currency: string; dueDays: number; footer: string };
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "system",
  locale: "en-US",
  notifications: { email: true, invoicePaid: true, weeklySummary: false },
  invoiceDefaults: { currency: "USD", dueDays: 30, footer: "" },
};

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T extends Plain>(target: T, source: Plain): T {
  for (const key of Object.keys(source)) {
    const incoming = source[key];
    const existing = (target as Plain)[key];
    if (isPlainObject(incoming) && isPlainObject(existing)) {
      deepMerge(existing, incoming);
    } else if (isPlainObject(incoming)) {
      (target as Plain)[key] = deepMerge({}, incoming);
    } else {
      (target as Plain)[key] = incoming;
    }
  }
  return target;
}

export async function loadSettings(userId: string): Promise<UserSettings> {
  const row = await queryOne<{ settings: Plain | null }>("SELECT settings FROM users WHERE id = $1", [userId]);
  return deepMerge(structuredClone(DEFAULT_SETTINGS) as unknown as Plain, row?.settings ?? {}) as unknown as UserSettings;
}

export async function saveSettings(userId: string, patch: Plain): Promise<UserSettings> {
  const current = (await loadSettings(userId)) as unknown as Plain;
  const merged = deepMerge(current, JSON.parse(JSON.stringify(patch)) as Plain);
  await queryOne("UPDATE users SET settings = $2 WHERE id = $1", [userId, merged]);
  return merged as unknown as UserSettings;
}
