CREATE INDEX "gw_attempts_request_idx" ON "gw_attempts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "gw_requests_created_at_idx" ON "gw_requests" USING btree ("created_at");