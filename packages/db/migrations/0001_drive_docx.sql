CREATE TABLE "drive_bindings" (
	"canvas_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"connected_user_id" text,
	"folder_id" text NOT NULL,
	"folder_name" text NOT NULL,
	"folder_path" text,
	"file_id" text,
	"file_name" text,
	"web_view_link" text,
	"last_revision_id" text,
	"last_md5" text,
	"last_content_hash" text,
	"last_version" integer DEFAULT 0 NOT NULL,
	"lock" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"anomaly" text,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_pending_deletions" (
	"file_id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"token_user_id" text,
	"folder_id" text,
	"folder_name" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gave_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"action" text NOT NULL,
	"version" integer,
	"reverted_from" integer,
	"canvas_version_id" text,
	"requested_by" text,
	"file_id" text,
	"drive_revision_id" text,
	"md5" text,
	"size_bytes" integer,
	"content_hash" text,
	"folder_id" text,
	"folder_name" text,
	"previous_folder_id" text,
	"previous_folder_name" text,
	"previous_file_id" text,
	"old_file_deleted_at" timestamp with time zone,
	"external_actor" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "email_prefs" SET DEFAULT '{"accessRequests":true,"decisions":true,"membership":true,"drive":true}'::jsonb;--> statement-breakpoint
ALTER TABLE "canvas_versions" ADD COLUMN "protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_bindings" ADD CONSTRAINT "drive_bindings_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_bindings" ADD CONSTRAINT "drive_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_bindings" ADD CONSTRAINT "drive_bindings_connected_user_id_users_id_fk" FOREIGN KEY ("connected_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_pending_deletions" ADD CONSTRAINT "drive_pending_deletions_token_user_id_users_id_fk" FOREIGN KEY ("token_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_publications" ADD CONSTRAINT "drive_publications_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_publications" ADD CONSTRAINT "drive_publications_canvas_version_id_canvas_versions_id_fk" FOREIGN KEY ("canvas_version_id") REFERENCES "public"."canvas_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_publications" ADD CONSTRAINT "drive_publications_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_publications_canvas_idx" ON "drive_publications" USING btree ("canvas_id","created_at");