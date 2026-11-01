CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"name" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_name_created_idx" ON "events" USING btree ("name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_daily_visit_unique" ON "events" USING btree ("user_id",(("created_at" at time zone 'UTC')::date)) WHERE "events"."name" = 'dashboard_visit';--> statement-breakpoint
CREATE INDEX "finding_events_type_created_idx" ON "finding_events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "findings_first_seen_idx" ON "findings" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "scans_created_idx" ON "scans" USING btree ("created_at");