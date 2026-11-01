CREATE TABLE "org_notices" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_notices_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
ALTER TABLE "org_billing" ADD COLUMN "credit_level" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_billing" ADD COLUMN "credit_level_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_notices" ADD CONSTRAINT "org_notices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;