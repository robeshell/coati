ALTER TABLE "gw_upstreams" ADD COLUMN "probe_token" text;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "probe_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_probe_status" text;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "last_probe_latency_ms" integer;