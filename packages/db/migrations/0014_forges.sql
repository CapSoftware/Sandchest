ALTER TABLE "orgs" DROP CONSTRAINT "orgs_github_account_id_unique";--> statement-breakpoint
ALTER TABLE "orgs" DROP CONSTRAINT "orgs_installation_id_unique";--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT "repos_github_repo_id_unique";--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_provider_account_unique" ON "orgs" USING btree ("provider","github_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_provider_installation_unique" ON "orgs" USING btree ("provider","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_provider_repo_unique" ON "repos" USING btree ("provider","github_repo_id");