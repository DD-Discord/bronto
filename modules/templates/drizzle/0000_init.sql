CREATE SCHEMA "templates";
--> statement-breakpoint
CREATE TABLE "templates"."forums" (
	"forum_channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "templates"."forums" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "templates"."template_images" (
	"template_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"message_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "template_images_template_id_slot_pk" PRIMARY KEY("template_id","slot")
);
--> statement-breakpoint
ALTER TABLE "templates"."template_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "templates"."templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"embed" jsonb,
	"show_post_time" boolean DEFAULT false NOT NULL,
	"thread_id" text NOT NULL,
	"preview_message_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "templates_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
ALTER TABLE "templates"."templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "templates"."forums" ADD CONSTRAINT "forums_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates"."template_images" ADD CONSTRAINT "template_images_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "templates"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates"."template_images" ADD CONSTRAINT "template_images_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates"."templates" ADD CONSTRAINT "templates_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forums_guild_id_idx" ON "templates"."forums" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forums_guild_id_key" ON "templates"."forums" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "template_images_guild_id_idx" ON "templates"."template_images" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "templates_guild_id_idx" ON "templates"."templates" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "forums_guild_isolation" ON "templates"."forums" AS PERMISSIVE FOR ALL TO public USING ("templates"."forums"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("templates"."forums"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "template_images_guild_isolation" ON "templates"."template_images" AS PERMISSIVE FOR ALL TO public USING ("templates"."template_images"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("templates"."template_images"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "templates_guild_isolation" ON "templates"."templates" AS PERMISSIVE FOR ALL TO public USING ("templates"."templates"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("templates"."templates"."guild_id" = current_setting('app.guild_id', true));