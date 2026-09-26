ALTER TABLE "gw_session_bindings" ADD COLUMN "id" serial NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_session_bindings" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_session_bindings" ADD CONSTRAINT "gw_session_bindings_id_unique" UNIQUE("id");