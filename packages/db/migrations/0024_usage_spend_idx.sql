-- One index on scan_usage: its build blocks writes to that table only, for as long as it takes. Give up rather than queue writers behind the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "scan_usage_created_idx" ON "scan_usage" USING btree ("created_at");