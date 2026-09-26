ALTER TABLE "gw_keys" ADD COLUMN "quota_group" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_keys" ADD COLUMN "rotated_from_id" integer;--> statement-breakpoint
ALTER TABLE "gw_keys" ADD CONSTRAINT "gw_keys_rotated_from_id_gw_keys_id_fk" FOREIGN KEY ("rotated_from_id") REFERENCES "public"."gw_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gw_keys_quota_group_idx" ON "gw_keys" USING btree ("quota_group");