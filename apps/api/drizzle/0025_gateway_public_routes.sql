CREATE TABLE "gw_public_routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"upstream_id" integer,
	"upstream_model" text,
	"vision_model" text,
	"description" text,
	"upstream_base" text,
	"fallback_enabled" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_public_routes_model_unique" UNIQUE("model")
);
--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "priority" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_public_routes" ADD CONSTRAINT "gw_public_routes_upstream_id_gw_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."gw_upstreams"("id") ON DELETE no action ON UPDATE no action;