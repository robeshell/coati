ALTER TABLE "gw_upstreams" ADD COLUMN "scope" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "owner_user_id" integer;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "model_prefix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD CONSTRAINT "gw_upstreams_owner_user_id_admin_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gw_upstreams_owner_scope_idx" ON "gw_upstreams" USING btree ("owner_user_id","scope");--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD CONSTRAINT "gw_upstreams_scope_owner_check" CHECK (("gw_upstreams"."scope" = 'platform' AND "gw_upstreams"."owner_user_id" IS NULL AND "gw_upstreams"."model_prefix" = '') OR ("gw_upstreams"."scope" = 'personal' AND "gw_upstreams"."owner_user_id" IS NOT NULL AND length(trim("gw_upstreams"."model_prefix")) > 0));