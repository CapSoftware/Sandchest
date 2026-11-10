-- One new table, referencing nothing: no other table is locked. Give up rather than queue writers behind any lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "credit_unit_switch" (
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"step" text NOT NULL,
	"record" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_unit_switch_kind_subject_pk" PRIMARY KEY("kind","subject")
);
