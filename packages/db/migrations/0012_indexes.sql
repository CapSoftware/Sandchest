CREATE INDEX "finding_events_scan_idx" ON "finding_events" USING btree ("scan_id") WHERE "finding_events"."scan_id" is not null;--> statement-breakpoint
CREATE INDEX "findings_source_scan_idx" ON "findings" USING btree ("source_scan_id");--> statement-breakpoint
CREATE INDEX "org_admins_org_idx" ON "org_admins" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "scans_unstarted_idx" ON "scans" USING btree ("created_at") WHERE "scans"."status" = 'queued' and "scans"."workflow_run_id" is null;--> statement-breakpoint
CREATE INDEX "scans_in_flight_idx" ON "scans" USING btree ("started_at") WHERE "scans"."status" in ('running', 'publishing');