CREATE TABLE "pr_comments" (
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"comment_id" bigint NOT NULL,
	"scan_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_comments_repo_id_pr_number_pk" PRIMARY KEY("repo_id","pr_number")
);
--> statement-breakpoint
DROP INDEX "scans_pr_head_unique";--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "pr_reviews" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "deep_scan_schedule" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "next_deep_scan_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pr_comments" ADD CONSTRAINT "pr_comments_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repos_next_deep_scan_idx" ON "repos" USING btree ("next_deep_scan_at") WHERE "repos"."next_deep_scan_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "scans_pr_head_unique" ON "scans" USING btree ("repo_id","pr_number","head_sha") WHERE "scans"."kind" = 'pr_review' and "scans"."status" in ('queued', 'running', 'publishing', 'completed');