CREATE TABLE "gw_legacy_imports" (
	"checksum" text PRIMARY KEY NOT NULL,
	"counts" jsonb NOT NULL,
	"id_map" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
