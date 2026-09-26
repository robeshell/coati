CREATE TABLE "gw_user_limits" (
	"owner_id" integer PRIMARY KEY NOT NULL,
	"daily_limit" bigint DEFAULT 0 NOT NULL,
	"concurrency_limit" integer DEFAULT 0 NOT NULL,
	"rpm_limit" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gw_user_limits" ADD CONSTRAINT "gw_user_limits_owner_id_admin_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;