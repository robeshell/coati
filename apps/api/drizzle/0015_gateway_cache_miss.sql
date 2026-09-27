ALTER TABLE "gw_requests" ADD COLUMN "cache_miss_tokens" bigint;--> statement-breakpoint
ALTER TABLE "gw_requests" ADD COLUMN "cache_miss_source" text;