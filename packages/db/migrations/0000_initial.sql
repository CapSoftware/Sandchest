CREATE TYPE "public"."dismiss_reason" AS ENUM('false_positive', 'accepted_risk', 'wont_fix');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'fixed', 'dismissed', 'verified');--> statement-breakpoint
CREATE TYPE "public"."scan_kind" AS ENUM('recon', 'pr_review', 'deep', 'fix_check');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('queued', 'running', 'publishing', 'completed', 'failed', 'cancelled', 'refused');--> statement-breakpoint
CREATE TABLE "finding_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"finding_id" uuid NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"scan_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"dismiss_reason" "dismiss_reason",
	"severity" text NOT NULL,
	"confidence" text NOT NULL,
	"category" text NOT NULL,
	"cwe" text,
	"title" text NOT NULL,
	"impact" text NOT NULL,
	"entry_point" jsonb NOT NULL,
	"attack_path" jsonb NOT NULL,
	"attacker" text NOT NULL,
	"preconditions" text NOT NULL,
	"proof_of_concept" text NOT NULL,
	"fix_guidance" text NOT NULL,
	"guarantees" jsonb NOT NULL,
	"must_not_break" jsonb NOT NULL,
	"regression_test" text NOT NULL,
	"fix_prompt" text NOT NULL,
	"source_scan_id" uuid,
	"source_kind" "scan_kind" NOT NULL,
	"pr_number" integer,
	"stale_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fixed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_account_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"type" text NOT NULL,
	"installation_id" bigint,
	"settings" jsonb DEFAULT '{"checkThreshold":"high"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_github_account_id_unique" UNIQUE("github_account_id"),
	CONSTRAINT "orgs_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "repo_memory" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"threat_model" jsonb NOT NULL,
	"commit_sha" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"private" boolean NOT NULL,
	"default_branch" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"loc" integer,
	"last_deep_scan_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_github_repo_id_unique" UNIQUE("github_repo_id")
);
--> statement-breakpoint
CREATE TABLE "scan_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_metrics" (
	"scan_id" uuid PRIMARY KEY NOT NULL,
	"input_tokens" bigint NOT NULL,
	"cached_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"requests" integer NOT NULL,
	"model_cost_usd" numeric(12, 6),
	"compute_cost_usd" numeric(12, 6),
	"duration_ms" integer NOT NULL,
	"candidates" integer NOT NULL,
	"survivors" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "scan_kind" NOT NULL,
	"status" "scan_status" DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"pr_number" integer,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"check_run_id" bigint,
	"workflow_run_id" text,
	"credits" integer DEFAULT 0 NOT NULL,
	"leads" jsonb,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_id_pk" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_source_scan_id_scans_id_fk" FOREIGN KEY ("source_scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_memory" ADD CONSTRAINT "repo_memory_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_metrics" ADD CONSTRAINT "scan_metrics_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_events_finding_idx" ON "finding_events" USING btree ("finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_repo_fingerprint_unique" ON "findings" USING btree ("repo_id","fingerprint");--> statement-breakpoint
CREATE INDEX "findings_repo_status_idx" ON "findings" USING btree ("repo_id","status");--> statement-breakpoint
CREATE INDEX "repos_org_idx" ON "repos" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_events_seq_unique" ON "scan_events" USING btree ("scan_id","seq");--> statement-breakpoint
CREATE INDEX "scans_repo_idx" ON "scans" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "scans_org_status_idx" ON "scans" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_pr_head_unique" ON "scans" USING btree ("repo_id","pr_number","head_sha") WHERE "scans"."kind" = 'pr_review';