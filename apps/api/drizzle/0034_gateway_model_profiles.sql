CREATE TABLE "gw_model_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"context_window_override" integer,
	"max_output_tokens_override" integer,
	"catalog_context_window" integer,
	"catalog_max_output_tokens" integer,
	"catalog_source" text,
	"catalog_synced_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_model_profiles_model_name_unique" UNIQUE("model_name"),
	CONSTRAINT "gw_model_profile_token_limits" CHECK (
  ("gw_model_profiles"."context_window_override" IS NULL OR "gw_model_profiles"."context_window_override" BETWEEN 1 AND 1000000) AND
  ("gw_model_profiles"."max_output_tokens_override" IS NULL OR "gw_model_profiles"."max_output_tokens_override" BETWEEN 1 AND 1000000) AND
  ("gw_model_profiles"."catalog_context_window" IS NULL OR "gw_model_profiles"."catalog_context_window" BETWEEN 1 AND 1000000) AND
  ("gw_model_profiles"."catalog_max_output_tokens" IS NULL OR "gw_model_profiles"."catalog_max_output_tokens" BETWEEN 1 AND 1000000))
);
