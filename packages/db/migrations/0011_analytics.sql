ALTER TABLE "events" ADD COLUMN "anon_id" uuid;--> statement-breakpoint
CREATE INDEX "events_user_created_idx" ON "events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "events_anon_created_idx" ON "events" USING btree ("anon_id","created_at");--> statement-breakpoint
CREATE INDEX "events_org_created_idx" ON "events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_identified_unique" ON "events" USING btree ("anon_id","user_id") WHERE "events"."name" = 'identified';