ALTER TABLE "gw_upstreams" ADD COLUMN "api_key_hint" text;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_latency_ms" integer;
--> statement-breakpoint
-- Preserve unknown historical update times; new rows receive their creation time.
ALTER TABLE "gw_upstreams" ALTER COLUMN "updated_at" SET DEFAULT now();
