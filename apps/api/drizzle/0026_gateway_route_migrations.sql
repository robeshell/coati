CREATE TABLE "gw_route_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"version" text NOT NULL,
	"actor_id" integer NOT NULL,
	"source_routes" jsonb NOT NULL,
	"public_route" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rolled_back_at" timestamp with time zone,
	"rolled_back_by" integer
);
