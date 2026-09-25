CREATE TABLE "gw_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"upstream_id" integer NOT NULL,
	"status" integer,
	"error" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gw_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"owner_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_devices_device_hash_unique" UNIQUE("device_hash"),
	CONSTRAINT "gw_devices_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE TABLE "gw_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'personal' NOT NULL,
	"digest" text NOT NULL,
	"prefix" text NOT NULL,
	"models" jsonb NOT NULL,
	"daily_limit" bigint DEFAULT 0 NOT NULL,
	"concurrency_limit" integer DEFAULT 10 NOT NULL,
	"rpm_limit" integer DEFAULT 60 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_keys_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
CREATE TABLE "gw_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" integer NOT NULL,
	"model" text NOT NULL,
	"protocol" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_tokens" bigint NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"usage_source" text DEFAULT 'estimated' NOT NULL,
	"error" text,
	"duration_ms" integer,
	"first_byte_ms" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gw_routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"upstream_id" integer NOT NULL,
	"upstream_model" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gw_upstreams" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"base_url" text NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gw_attempts" ADD CONSTRAINT "gw_attempts_request_id_gw_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."gw_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_attempts" ADD CONSTRAINT "gw_attempts_upstream_id_gw_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."gw_upstreams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_devices" ADD CONSTRAINT "gw_devices_owner_id_admin_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_keys" ADD CONSTRAINT "gw_keys_owner_id_admin_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_requests" ADD CONSTRAINT "gw_requests_key_id_gw_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."gw_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_routes" ADD CONSTRAINT "gw_routes_upstream_id_gw_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."gw_upstreams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gw_requests_key_time_idx" ON "gw_requests" USING btree ("key_id","created_at");--> statement-breakpoint
CREATE INDEX "gw_requests_status_expiry_idx" ON "gw_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "gw_routes_model_idx" ON "gw_routes" USING btree ("model");