CREATE SCHEMA "forms";
--> statement-breakpoint
CREATE TABLE "forms"."drafts" (
	"form_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"dry" boolean DEFAULT false NOT NULL,
	"page" integer DEFAULT 0 NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "drafts_form_id_user_id_dry_pk" PRIMARY KEY("form_id","user_id","dry")
);
--> statement-breakpoint
ALTER TABLE "forms"."drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forms"."forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"preview_message_id" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"channel_id" text,
	"ping_user_ids" text[] DEFAULT '{}' NOT NULL,
	"ping_role_ids" text[] DEFAULT '{}' NOT NULL,
	"allowed_role_ids" text[] DEFAULT '{}' NOT NULL,
	"once_per_member" boolean DEFAULT true NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removed_field_ids" text[] DEFAULT '{}' NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "forms_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
ALTER TABLE "forms"."forms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forms"."forums" (
	"forum_channel_id" text PRIMARY KEY NOT NULL,
	"drafts_thread_id" text,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "forms"."forums" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forms"."openers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"template_id" uuid,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "forms"."openers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forms"."submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answers" jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"channel_id" text NOT NULL,
	"status" text NOT NULL,
	"part_message_ids" text[] DEFAULT '{}' NOT NULL,
	"render" jsonb NOT NULL,
	"once" boolean NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "forms"."submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forms"."drafts" ADD CONSTRAINT "drafts_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms"."drafts" ADD CONSTRAINT "drafts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms"."forms" ADD CONSTRAINT "forms_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms"."forums" ADD CONSTRAINT "forums_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms"."openers" ADD CONSTRAINT "openers_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms"."openers" ADD CONSTRAINT "openers_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms"."submissions" ADD CONSTRAINT "submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms"."submissions" ADD CONSTRAINT "submissions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drafts_guild_id_idx" ON "forms"."drafts" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "forms_guild_id_idx" ON "forms"."forms" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "forums_guild_id_idx" ON "forms"."forums" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forums_guild_id_key" ON "forms"."forums" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "openers_guild_id_idx" ON "forms"."openers" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "openers_form_id_idx" ON "forms"."openers" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "submissions_guild_id_idx" ON "forms"."submissions" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_once_key" ON "forms"."submissions" USING btree ("form_id","user_id") WHERE "forms"."submissions"."once";--> statement-breakpoint
CREATE POLICY "drafts_guild_isolation" ON "forms"."drafts" AS PERMISSIVE FOR ALL TO public USING ("forms"."drafts"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("forms"."drafts"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "forms_guild_isolation" ON "forms"."forms" AS PERMISSIVE FOR ALL TO public USING ("forms"."forms"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("forms"."forms"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "forums_guild_isolation" ON "forms"."forums" AS PERMISSIVE FOR ALL TO public USING ("forms"."forums"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("forms"."forums"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "openers_guild_isolation" ON "forms"."openers" AS PERMISSIVE FOR ALL TO public USING ("forms"."openers"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("forms"."openers"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "submissions_guild_isolation" ON "forms"."submissions" AS PERMISSIVE FOR ALL TO public USING ("forms"."submissions"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("forms"."submissions"."guild_id" = current_setting('app.guild_id', true));