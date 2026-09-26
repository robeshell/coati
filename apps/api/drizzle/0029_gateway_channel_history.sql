ALTER TABLE "gw_attempts" DROP CONSTRAINT "gw_attempts_upstream_id_gw_upstreams_id_fk";
--> statement-breakpoint
ALTER TABLE "gw_attempts" ALTER COLUMN "upstream_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_attempts" ADD CONSTRAINT "gw_attempts_upstream_id_gw_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."gw_upstreams"("id") ON DELETE set null ON UPDATE no action;