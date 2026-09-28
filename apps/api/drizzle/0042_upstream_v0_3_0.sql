CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_id" integer,
	"name" varchar(100) NOT NULL,
	"code" varchar(50) NOT NULL,
	"leader_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp,
	CONSTRAINT "departments_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "role_depts" (
	"role_id" integer NOT NULL,
	"dept_id" integer NOT NULL,
	CONSTRAINT "role_depts_pkey" PRIMARY KEY("role_id","dept_id")
);
--> statement-breakpoint
CREATE TABLE "file_references" (
	"file_id" uuid NOT NULL,
	"ref_table" varchar(50) NOT NULL,
	"ref_id" varchar(50) NOT NULL,
	"ref_field" varchar(50) NOT NULL,
	"created_at" timestamp,
	CONSTRAINT "file_references_pkey" PRIMARY KEY("file_id","ref_table","ref_id","ref_field")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage" varchar(20) NOT NULL,
	"bucket" varchar(100),
	"object_key" varchar(200) NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"uploader_id" integer,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"requested_ip" varchar(64),
	"created_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(500),
	"mfa_state" varchar(20),
	"created_at" timestamp,
	"last_seen_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"verified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "user_recovery_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"created_at" timestamp,
	"used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"token_prefix" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"last_used_ip" varchar(64),
	"created_by" integer NOT NULL,
	"created_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"webhook_id" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"event" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_code" integer,
	"response_body" text,
	"next_retry_at" timestamp,
	"delivered_at" timestamp,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"url" varchar(500) NOT NULL,
	"events" jsonb NOT NULL,
	"secret" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "demo_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"code" varchar(50) NOT NULL,
	"category" varchar(50),
	"status" varchar(50) DEFAULT 'todo' NOT NULL,
	"owner" varchar(50),
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"amount" numeric(10, 2),
	"quantity" integer,
	"progress" integer DEFAULT 0 NOT NULL,
	"start_date" date,
	"end_date" date,
	"parent_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"board_order" integer DEFAULT 0 NOT NULL,
	"cover" varchar(36),
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp,
	CONSTRAINT "demo_records_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "admin_users" DROP CONSTRAINT "admin_users_username_key";--> statement-breakpoint
ALTER TABLE "menus" DROP CONSTRAINT "menus_code_key";--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "roles_code_key";--> statement-breakpoint
ALTER TABLE "dict_items" DROP CONSTRAINT "uq_dict_items_type_value";--> statement-breakpoint
ALTER TABLE "dict_types" DROP CONSTRAINT "dict_types_code_key";--> statement-breakpoint
ALTER TABLE "scheduled_tasks" DROP CONSTRAINT "scheduled_tasks_task_code_key";--> statement-breakpoint
ALTER TABLE "notification_reads" DROP CONSTRAINT "notification_reads_notification_id_user_id_key";--> statement-breakpoint
ALTER TABLE "menus" DROP CONSTRAINT "menus_parent_id_fkey";
--> statement-breakpoint
ALTER TABLE "role_menus" DROP CONSTRAINT "role_menus_menu_id_fkey";
--> statement-breakpoint
ALTER TABLE "role_menus" DROP CONSTRAINT "role_menus_role_id_fkey";
--> statement-breakpoint
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_role_id_fkey";
--> statement-breakpoint
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "login_logs" DROP CONSTRAINT "login_logs_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "operation_logs" DROP CONSTRAINT "operation_logs_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "dict_items" DROP CONSTRAINT "dict_items_dict_type_id_fkey";
--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" DROP CONSTRAINT "scheduled_task_runs_task_id_fkey";
--> statement-breakpoint
ALTER TABLE "notification_reads" DROP CONSTRAINT "notification_reads_notification_id_fkey";
--> statement-breakpoint
ALTER TABLE "notification_reads" DROP CONSTRAINT "notification_reads_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_user_id_fkey";
--> statement-breakpoint
DROP INDEX "ix_login_logs_status_created_at";--> statement-breakpoint
DROP INDEX "ix_dict_items_dict_type_id";--> statement-breakpoint
DROP INDEX "ix_scheduled_task_runs_status";--> statement-breakpoint
DROP INDEX "ix_scheduled_task_runs_task_id";--> statement-breakpoint
DROP INDEX "ix_scheduled_tasks_is_active";--> statement-breakpoint
DROP INDEX "ix_scheduled_tasks_next_run_at";--> statement-breakpoint
DROP INDEX "ix_ai_prompt_templates_category";--> statement-breakpoint
DROP INDEX "ix_ai_prompt_templates_name";--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "nickname" varchar(100);--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "email" varchar(100);--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "phone" varchar(20);--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "avatar" varchar(500);--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "dept_id" integer;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "last_login_at" timestamp;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "last_login_ip" varchar(64);--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_enabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "data_scope" varchar(20) DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "operation_logs" ADD COLUMN "api_token_id" integer;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_leader_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_depts" ADD CONSTRAINT "role_depts_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_depts" ADD CONSTRAINT "role_depts_dept_id_fk" FOREIGN KEY ("dept_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploader_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_records" ADD CONSTRAINT "demo_records_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."demo_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_references_ref_idx" ON "file_references" USING btree ("ref_table","ref_id");--> statement-breakpoint
CREATE INDEX "files_sha256_idx" ON "files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "files_created_at_idx" ON "files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_recovery_codes_user_id_idx" ON "user_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_tokens_token_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_created_by_idx" ON "api_tokens" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "demo_records_parent_id_idx" ON "demo_records" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_dept_id_departments_id_fk" FOREIGN KEY ("dept_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_menus" ADD CONSTRAINT "role_menus_menu_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_menus" ADD CONSTRAINT "role_menus_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_logs" ADD CONSTRAINT "login_logs_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_api_token_id_fk" FOREIGN KEY ("api_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dict_items" ADD CONSTRAINT "dict_items_dict_type_id_fk" FOREIGN KEY ("dict_type_id") REFERENCES "public"."dict_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_task_runs" ADD CONSTRAINT "scheduled_task_runs_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_logs_status_created_at_idx" ON "login_logs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "dict_items_dict_type_id_idx" ON "dict_items" USING btree ("dict_type_id");--> statement-breakpoint
CREATE INDEX "scheduled_task_runs_status_idx" ON "scheduled_task_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scheduled_task_runs_task_id_idx" ON "scheduled_task_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_is_active_idx" ON "scheduled_tasks" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_next_run_at_idx" ON "scheduled_tasks" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "ai_prompt_templates_category_idx" ON "ai_prompt_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "ai_prompt_templates_name_idx" ON "ai_prompt_templates" USING btree ("name");--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_username_unique" UNIQUE("username");--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_email_unique" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "dict_items" ADD CONSTRAINT "dict_items_type_value_unique" UNIQUE("dict_type_id","value");--> statement-breakpoint
ALTER TABLE "dict_types" ADD CONSTRAINT "dict_types_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_task_code_unique" UNIQUE("task_code");--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notification_id_user_id_unique" UNIQUE("notification_id","user_id");
--> statement-breakpoint
-- Upstream 0002/0005 menu DML, matched by code (never by Coati's business IDs).
DELETE FROM "menus" WHERE "code" IN ('cc_3d', 'cc_3d_particle', 'cc_3d_css', 'cc_3d_globe', 'cc_3d_morphing', 'cc_admin', 'cc_admin_list', 'cc_admin_stats_list', 'cc_admin_card_list', 'cc_admin_tree_list', 'cc_admin_dynamic_form', 'cc_admin_kanban', 'cc_admin_detail_tabs', 'cc_admin_gantt', 'cc_admin_advanced_table');
--> statement-breakpoint
-- file_references is new in this chain. There are no saved_queries tables in Coati;
-- keep all old demo tables and their data rather than transplanting upstream DROP TABLEs.
DELETE FROM "file_references" WHERE "ref_table" = 'saved_queries';
--> statement-breakpoint
-- Upstream 0004 data backfill; demo_records is new here, so this is normally a no-op.
UPDATE "demo_records" AS d SET "board_order" = r.rn
FROM (SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "status" ORDER BY "sort_order", "id") - 1)::integer AS rn FROM "demo_records") AS r
WHERE d."id" = r."id";
