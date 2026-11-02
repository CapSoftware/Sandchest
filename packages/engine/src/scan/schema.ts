/**
 * The shapes that flow through a scan: what hunters report, what the skeptic
 * decides, and the finding that comes out the other end.
 */
import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Rule classes. Part of a finding's fingerprint, so keep names stable. */
export const CATEGORIES = [
  "sql_injection",
  "nosql_injection",
  "command_injection",
  "code_injection",
  "template_injection",
  "path_traversal",
  "ssrf",
  "xss",
  "xxe",
  "insecure_deserialization",
  "broken_access_control",
  "broken_authentication",
  "privilege_escalation",
  "mass_assignment",
  "open_redirect",
  "hardcoded_secret",
  "weak_cryptography",
  "sensitive_data_exposure",
  "vulnerable_dependency",
  "prototype_pollution",
  "csrf",
  "unrestricted_file_upload",
  "denial_of_service",
  "business_logic",
  "race_condition",
  "resource_abuse",
  "prompt_injection",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Who can exploit it. */
export const ATTACKERS = ["unauthenticated", "any_user", "insider", "admin"] as const;
export type Attacker = (typeof ATTACKERS)[number];

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

const Location = {
  file: z.string().min(1).describe("Repository-relative path"),
  line: z.number().int().positive().describe("1-based line number"),
};

const Step = z.object({
  ...Location,
  note: z.string().min(3).max(400).describe("What happens to the attacker's input at this line"),
});
export type Step = z.infer<typeof Step>;

/** What a hunter reports. Doubles as the evidence gate's first check: every field is required. */
export const CandidateSchema = z.object({
  title: z.string().min(8).max(140).describe("Short, specific title, e.g. 'SQL injection in login via email field'"),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES).describe("Who can exploit it × what they get, per the rubric"),
  entryPoint: z
    .object({ ...Location, description: z.string().min(3).max(200).describe("e.g. 'POST /rest/user/login, body.email'") })
    .describe("Where untrusted input enters"),
  path: z
    .array(Step)
    .min(1)
    .max(12)
    .describe("Source → sink, in order. Each hop is a real file:line you have read. The last hop is the sink or the missing check."),
  preconditions: z.object({
    attacker: z.enum(ATTACKERS),
    details: z.string().max(400).describe("Anything else that must hold, or 'none'"),
  }),
  proofOfConcept: z.string().min(20).max(2_000).describe("A concrete request, payload or input that triggers it"),
  impact: z.string().min(10).max(300).describe("One sentence: what the attacker gets, e.g. 'reads every customer's invoices'"),
  leads: z.array(z.string()).max(10).optional().describe("Ids of the leads this finding explains, if any"),
});
export type Candidate = z.infer<typeof CandidateSchema>;

const Citation = z.object({ ...Location, explanation: z.string().min(3).max(400) });

/** The skeptic's ruling on one candidate. */
export const VerdictSchema = z.object({
  verdict: z
    .enum(["confirmed", "disproved"])
    .describe("'disproved' only if you can cite the code that stops the attack; otherwise 'confirmed'"),
  confidence: z.enum(CONFIDENCES).describe("How sure you are the attack works as described"),
  disproof: z.array(Citation).max(6).describe("Required when disproved: the exact lines that block the attack. Empty otherwise."),
  severity: z.enum(SEVERITIES).describe("Severity after your review, per the rubric"),
  reasoning: z.string().min(10).max(2_000).describe("What you checked and why you reached this verdict"),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** The structure pass: write-up fields the model produces. Strict JSON schema, so no optional fields. */
export const WriteUpSchema = z.object({
  title: z.string().min(8).max(140),
  severity: z.enum(SEVERITIES),
  cwe: z
    .string()
    .regex(/^CWE-\d+$/)
    .nullable(),
  impact: z.string().min(10).max(300).describe("One sentence: what the attacker gets"),
  preconditions: z.string().min(3).max(400).describe("Who can exploit it and what must hold, in plain English"),
  proofOfConcept: z.string().min(20).max(2_000),
  fixGuidance: z.string().min(20).max(1_500).describe("How to fix it, specific to this code"),
  guarantees: z.array(z.string().min(5).max(300)).min(1).max(6).describe("What the fix must guarantee"),
  mustNotBreak: z.array(z.string().min(5).max(300)).max(6).describe("Behaviour the fix must preserve"),
  regressionTest: z.string().min(20).max(1_500).describe("A test that reproduces the attack and passes once fixed"),
});
export type WriteUp = z.infer<typeof WriteUpSchema>;

export interface PathStep extends Step {
  /** The cited line with a line of context either side, read from the checkout. */
  excerpt: string;
}

/**
 * The outcome of validating a finding. A ladder of trust, strongest first:
 *   - `verified`: the attack was reproduced against a running instance and a
 *     deterministic oracle confirmed it (runtime validation — "we did it").
 *   - `path_confirmed`: the index proves the attacker-reachable path from entry
 *     to sink is real in the code, without running anything (code-path proof).
 *     Weaker than `verified`: the path exists, but exploitability was not
 *     executed. This runs in every scan.
 *   - `inconclusive`: neither held — the path could not be confirmed on its
 *     own, the app would not boot, or a probe did not fire.
 *
 * Validation only ever *raises* trust; it never downgrades or drops a finding,
 * so a missing index edge or a flaky bring-up can never bury a real bug. A
 * finding with no `validation` was not put through the stage at all.
 */
export type ValidationStatus = "verified" | "path_confirmed" | "inconclusive";

/** How much independent evidence backs a finding. Strongest first. See `trust.ts`. */
export const TRUST_TIERS = ["confirmed", "corroborated", "unconfirmed"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export interface Validation {
  status: ValidationStatus;
  /** How it was checked, e.g. `code-path`, `two-tenant`. Shown in diagnostics; never a secret. */
  method: string;
  /** One plain-English line: no code, payloads, secrets or identifiers. */
  detail: string;
}

export interface Finding {
  /** Stable across scans: rule class + sink location + entry point. */
  fingerprint: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  category: Category;
  cwe: string | null;
  impact: string;
  entryPoint: Candidate["entryPoint"];
  attackPath: PathStep[];
  attacker: Attacker;
  preconditions: string;
  proofOfConcept: string;
  fixGuidance: string;
  guarantees: string[];
  mustNotBreak: string[];
  regressionTest: string;
  fixPrompt: string;
  /** Leads this finding explains. */
  leads: string[];
  skeptic: { confidence: Confidence; reasoning: string };
  /** Present only when the finding went through dynamic validation. */
  validation?: Validation;
  /** How much independent evidence backs the finding; set by the trust gate. See `trust.ts`. */
  trust?: TrustTier;
}

const EntryPoint = z.object({
  kind: z.enum(["http", "graphql", "websocket", "server_action", "cli", "job", "queue", "webhook", "file_upload", "other"]),
  location: z.string().describe("Route or file:line"),
  description: z.string(),
  auth: z.enum(["public", "authenticated", "admin", "unknown"]),
});

/**
 * Repo memory: what the app is and where its attack surface lies. Summary
 * text only, never source. It opens every hunt and skeptic prompt, so it is
 * also the stable prefix the model caches.
 */
export const ThreatModelSchema = z.object({
  summary: z.string().describe("What the application does and who uses it, in two or three sentences"),
  stack: z.array(z.string()).describe("Languages, frameworks and data stores"),
  entryPoints: z.array(EntryPoint).max(40).describe("The most security-relevant entry points"),
  authModel: z.string().describe("How users authenticate and how authorisation is enforced, citing where"),
  trustBoundaries: z.array(z.string()),
  sensitiveAssets: z.array(z.string()),
  dangerousSinks: z.array(z.object({ kind: z.string(), location: z.string(), note: z.string() })).max(30),
  frameworkProtections: z.array(z.string()).describe("Protections the framework or code applies by default"),
  abuseSurfaces: z
    .array(z.string())
    .max(20)
    .describe("Flows worth abusing, with where they live: payments, plans, credits, quotas, coupons, invites, sharing, messaging, and per-request costs (AI, transcoding, storage, exports)"),
  subsystems: z
    .array(
      z.object({
        name: z.string(),
        paths: z.array(z.string()).min(1).describe("Directory or file prefixes"),
        description: z.string(),
        risk: z.enum(["high", "medium", "low"]),
      }),
    )
    .max(12)
    .describe("Areas of the codebase to hunt in separately, riskiest first"),
});
export type ThreatModel = z.infer<typeof ThreatModelSchema>;

/**
 * How the application actually enforces authorization, investigated from the
 * code rather than assumed from a framework. Language- and framework-agnostic:
 * the model reads whatever is there (tRPC procedures, Rails before_actions,
 * Express middleware, Next server actions, Spring guards, decorators…) and
 * describes the real mechanism. This grounds the skeptic so it judges an
 * access-control finding against how this app enforces authz, not a guess.
 */
export const AuthModelSchema = z.object({
  summary: z.string().min(10).describe("How identity is established and how authorization is enforced here, in plain English"),
  enforcementPoints: z
    .array(
      z.object({
        mechanism: z.string().describe("The concrete mechanism, e.g. 'tRPC authedProcedure', 'Express requireAuth middleware', 'getCurrentUser() guard in each server action'"),
        where: z.string().describe("file:line where it is defined or applied"),
        protects: z.string().describe("What it gates, and what it checks (identity only, role, object ownership)"),
      }),
    )
    .max(20)
    .describe("The checks that enforce authorization, each with where it lives"),
  ownershipPattern: z.string().describe("How handlers ensure a caller may act on the SPECIFIC object they request (e.g. queries scoped by session user/org id), with an example file:line, or 'none found'"),
  gaps: z.array(z.string()).max(20).describe("Entry points or patterns that skip the enforcement above, each with file:line"),
});
export type AuthModel = z.infer<typeof AuthModelSchema>;

export type LeadKind = "secret" | "vulnerable_dependency" | "injection_marker" | "sink" | "missing_check";

/** A deterministic signal. The model can investigate and rank leads, never suppress them. */
export interface Lead {
  id: string;
  kind: LeadKind;
  title: string;
  /** `file:line` when the lead has a location. */
  at?: string;
  detail: string;
  severity?: Severity;
}
