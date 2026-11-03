CREATE TABLE "credit_claims" (
	"github_account_id" bigint PRIMARY KEY NOT NULL,
	"github_user_id" bigint NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone,
	CONSTRAINT "credit_claims_github_user_id_unique" UNIQUE("github_user_id")
);
