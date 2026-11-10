-- Two new tables and one nullable column with no default: no rewrite. The foreign keys take brief locks on orgs and scans: give up rather than queue writers behind them.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "scan_bills" (
	"scan_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"engine" text NOT NULL,
	"fast" boolean DEFAULT false NOT NULL,
	"multiplier_thousandths" integer NOT NULL,
	"credit_micro_usd" integer NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	"due_micro_usd" bigint NOT NULL,
	"reserved_credits" integer NOT NULL,
	"credits" integer NOT NULL,
	"carry_in_micro_usd" bigint NOT NULL,
	"carry_out_micro_usd" bigint NOT NULL,
	"capped" boolean DEFAULT false NOT NULL,
	"lines" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "scan_bills_status" CHECK ("scan_bills"."status" in ('open', 'charged', 'waived', 'voided', 'shadow')),
	CONSTRAINT "scan_bills_amounts" CHECK ("scan_bills"."credit_micro_usd" > 0 and "scan_bills"."multiplier_thousandths" >= 0 and "scan_bills"."cost_micro_usd" >= 0 and "scan_bills"."due_micro_usd" >= 0 and "scan_bills"."reserved_credits" >= 0 and "scan_bills"."credits" >= 0 and "scan_bills"."credits" <= "scan_bills"."reserved_credits" and "scan_bills"."carry_in_micro_usd" >= 0 and "scan_bills"."carry_out_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_carry" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"carry_micro_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_carry_not_negative" CHECK ("usage_carry"."carry_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "scan_bills" ADD CONSTRAINT "scan_bills_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_bills" ADD CONSTRAINT "scan_bills_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_carry" ADD CONSTRAINT "usage_carry_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_bills_org_idx" ON "scan_bills" USING btree ("org_id","created_at");