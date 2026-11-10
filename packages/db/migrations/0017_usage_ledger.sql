-- New table only. The foreign key to scans takes a brief lock on it: give up rather than queue writers behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "scan_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"stage" text NOT NULL,
	"role" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"seconds" numeric(12, 3),
	"cost_usd" numeric(18, 10) NOT NULL,
	"cost_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scan_usage" ADD CONSTRAINT "scan_usage_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_usage_scan_idx" ON "scan_usage" USING btree ("scan_id");