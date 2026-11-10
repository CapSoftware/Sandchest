-- One nullable column with no default: no table rewrite, and code that does not know it keeps working. Give up rather than queue writers behind the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "also_reported" jsonb;
