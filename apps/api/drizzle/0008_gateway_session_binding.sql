CREATE TABLE "gw_session_bindings" (
	"scope" text PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"model" text NOT NULL,
	"upstream_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gw_session_bindings" ADD CONSTRAINT "gw_session_bindings_owner_id_admin_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_session_bindings" ADD CONSTRAINT "gw_session_bindings_upstream_id_gw_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."gw_upstreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gw_session_bindings_expiry_idx" ON "gw_session_bindings" USING btree ("expires_at");