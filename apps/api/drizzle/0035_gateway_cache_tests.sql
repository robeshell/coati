CREATE TABLE "gw_cache_tests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"rounds" integer NOT NULL,
	"max_tokens" integer NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gw_cache_tests" ADD CONSTRAINT "gw_cache_tests_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gw_cache_tests_owner_time_idx" ON "gw_cache_tests" USING btree ("user_id","created_at");