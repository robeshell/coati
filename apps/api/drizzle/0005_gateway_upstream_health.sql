ALTER TABLE "gw_upstreams" ADD COLUMN "health_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "health_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_error" text;