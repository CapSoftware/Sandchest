-- New table only. The foreign key to scans takes a brief lock on it: give up rather than queue writers behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "scan_stages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "scan_stages" ADD CONSTRAINT "scan_stages_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scan_stages_run_unique" ON "scan_stages" USING btree ("scan_id","stage","attempt");--> statement-breakpoint
CREATE INDEX "scan_stages_scan_idx" ON "scan_stages" USING btree ("scan_id");