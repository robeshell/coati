-- Existing rows have no reliable historical update time. Preserve that as NULL.
ALTER TABLE "gw_public_routes" ADD COLUMN "updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "gw_public_routes" ALTER COLUMN "updated_at" SET DEFAULT now();
