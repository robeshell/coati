CREATE TABLE "gw_upstream_leases" (
	"request_id" text PRIMARY KEY NOT NULL,
	"upstream_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "concurrency_limit" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_upstream_leases" ADD CONSTRAINT "gw_upstream_leases_request_id_gw_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."gw_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_upstream_leases" ADD CONSTRAINT "gw_upstream_leases_upstream_id_gw_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."gw_upstreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gw_upstream_leases_account_expiry_idx" ON "gw_upstream_leases" USING btree ("upstream_id","expires_at");