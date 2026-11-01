CREATE TABLE "org_billing" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" text,
	"past_due" boolean DEFAULT false NOT NULL,
	"ends_at" timestamp with time zone,
	"renews_at" timestamp with time zone,
	"next_plan_id" text,
	"credits" integer DEFAULT 0 NOT NULL,
	"credits_reset_at" timestamp with time zone,
	"auto_top_up" jsonb,
	"activated_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "credits_reserved" integer;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "billing" text;--> statement-breakpoint
ALTER TABLE "org_billing" ADD CONSTRAINT "org_billing_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scans_billing_reserved_idx" ON "scans" USING btree ("status") WHERE "scans"."billing" = 'reserved';