-- New tables only. The foreign keys to repos take a brief lock on it: give up rather than queue writers behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "advisories" (
	"id" text PRIMARY KEY NOT NULL,
	"vuln_key" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary" text NOT NULL,
	"details" text NOT NULL,
	"severity" text NOT NULL,
	"score" real,
	"vector" text,
	"malicious" boolean DEFAULT false NOT NULL,
	"affected" jsonb NOT NULL,
	"references" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"modified_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisory_feeds" (
	"ecosystem" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"handled" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_advisories" (
	"repo_id" uuid NOT NULL,
	"advisory_id" text NOT NULL,
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"origin" text NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "repo_advisories_repo_id_advisory_id_ecosystem_name_version_pk" PRIMARY KEY("repo_id","advisory_id","ecosystem","name","version")
);
--> statement-breakpoint
CREATE TABLE "repo_dependencies" (
	"repo_id" uuid NOT NULL,
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"package_key" text NOT NULL,
	"version" text NOT NULL,
	"manifest" text NOT NULL,
	"direct" boolean NOT NULL,
	"dev" boolean NOT NULL,
	"usage" text NOT NULL,
	"approximate" boolean DEFAULT false NOT NULL,
	"imported_at" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "repo_dependencies_repo_id_ecosystem_name_version_pk" PRIMARY KEY("repo_id","ecosystem","name","version")
);
--> statement-breakpoint
CREATE TABLE "repo_inventories" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"commit_sha" text,
	"captured_at" timestamp with time zone,
	"dependencies" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	"requested_at" timestamp with time zone,
	"running_since" timestamp with time zone,
	"error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "repo_advisories" ADD CONSTRAINT "repo_advisories_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_advisories" ADD CONSTRAINT "repo_advisories_advisory_id_advisories_id_fk" FOREIGN KEY ("advisory_id") REFERENCES "public"."advisories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_dependencies" ADD CONSTRAINT "repo_dependencies_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_inventories" ADD CONSTRAINT "repo_inventories_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advisories_vuln_key_idx" ON "advisories" USING btree ("vuln_key");--> statement-breakpoint
CREATE INDEX "advisories_aliases_idx" ON "advisories" USING gin ("aliases");--> statement-breakpoint
CREATE INDEX "repo_advisories_open_idx" ON "repo_advisories" USING btree ("repo_id") WHERE "repo_advisories"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "repo_advisories_advisory_idx" ON "repo_advisories" USING btree ("advisory_id");--> statement-breakpoint
CREATE INDEX "repo_dependencies_package_idx" ON "repo_dependencies" USING btree ("ecosystem","package_key");--> statement-breakpoint
CREATE INDEX "repo_inventories_checked_idx" ON "repo_inventories" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "repo_inventories_requested_idx" ON "repo_inventories" USING btree ("requested_at") WHERE "repo_inventories"."requested_at" is not null;