-- Two columns with constant defaults: no table rewrite. Give up rather than queue writers behind the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "scan_usage" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_usage" ADD COLUMN "status" text DEFAULT 'ok' NOT NULL;