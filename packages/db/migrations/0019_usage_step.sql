-- Two columns (one with a constant default, one empty) and a unique index, on a table that is new: no rewrite. Give up rather than queue writers behind the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "scan_usage" ADD COLUMN "step" text DEFAULT 'execute' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_usage" ADD COLUMN "key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "scan_usage_key_unique" ON "scan_usage" USING btree ("key");