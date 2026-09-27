ALTER TABLE "gw_requests" ADD COLUMN "cache_read_tokens" bigint;--> statement-breakpoint
ALTER TABLE "gw_requests" ADD COLUMN "cache_write_tokens" bigint;--> statement-breakpoint
ALTER TABLE "gw_requests" ADD COLUMN "cache_write_5m_tokens" bigint;--> statement-breakpoint
ALTER TABLE "gw_requests" ADD COLUMN "cache_write_1h_tokens" bigint;--> statement-breakpoint
ALTER TABLE "gw_requests" ADD COLUMN "reasoning_tokens" bigint;--> statement-breakpoint
ALTER TABLE "gw_requests" ADD COLUMN "upstream_protocol" text;--> statement-breakpoint
ALTER TABLE "gw_requests" ADD COLUMN "raw_usage" jsonb;