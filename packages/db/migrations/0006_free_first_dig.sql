ALTER TABLE "orgs" ADD COLUMN "free_dig_scan_id" uuid;--> statement-breakpoint
-- Orgs that already have a deep scan (finished, or under way at deploy time) have had their first one.
UPDATE "orgs" o SET "free_dig_scan_id" = (
  SELECT s."id" FROM "scans" s WHERE s."org_id" = o."id" AND s."kind" = 'deep' AND s."status" IN ('queued', 'running', 'publishing', 'completed') ORDER BY s."created_at" LIMIT 1
) WHERE o."free_dig_scan_id" IS NULL;
