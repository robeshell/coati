CREATE TABLE "gw_search_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_search_settings_singleton" CHECK ("gw_search_settings"."id"=1)
);
