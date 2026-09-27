ALTER TABLE "gw_user_limits" ALTER COLUMN "daily_limit" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "gw_user_limits" ALTER COLUMN "daily_limit" DROP NOT NULL;