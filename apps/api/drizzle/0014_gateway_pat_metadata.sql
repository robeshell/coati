ALTER TABLE "gw_keys" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "gw_keys" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_keys" ADD COLUMN "last_used_at" timestamp with time zone;