-- One column with a constant default: no table rewrite. Give up rather than queue writers behind the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "fast" boolean DEFAULT false NOT NULL;