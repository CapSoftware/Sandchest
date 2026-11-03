/** Every operation an agent can call, in the order docs and tool lists show them. */
import { accountOps } from "./ops/account";
import { accountsOps } from "./ops/accounts";
import { billingOps } from "./ops/billing";
import { findingOps } from "./ops/findings";
import { scanOps } from "./ops/scans";
import type { Operation } from "./operation";

export const OPERATIONS: readonly Operation[] = [...accountOps, ...accountsOps, ...billingOps, ...scanOps, ...findingOps];

const byName = new Map(OPERATIONS.map((op) => [op.name, op]));

export function operationByName(name: string): Operation | undefined {
  return byName.get(name);
}
