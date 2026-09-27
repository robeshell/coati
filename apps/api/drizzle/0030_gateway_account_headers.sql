ALTER TABLE "gw_upstreams" ADD COLUMN "extra_headers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "note" text;