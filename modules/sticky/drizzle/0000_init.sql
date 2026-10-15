CREATE SCHEMA "sticky";
--> statement-breakpoint
CREATE TABLE "sticky"."stickies" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"parent_channel_id" text,
	"webhook_id" text NOT NULL,
	"webhook_token" text NOT NULL,
	"template_channel_id" text NOT NULL,
	"template_message_id" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"embeds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ignore_bots" boolean DEFAULT true NOT NULL,
	"silent" boolean DEFAULT true NOT NULL,
	"debounce_ms" integer DEFAULT 0 NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sticky"."sticky_state" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"last_message_id" text,
	"repost_due_at" timestamp with time zone,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "sticky"."sticky_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ADD CONSTRAINT "stickies_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticky"."sticky_state" ADD CONSTRAINT "sticky_state_channel_id_stickies_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "sticky"."stickies"("channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticky"."sticky_state" ADD CONSTRAINT "sticky_state_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stickies_guild_id_idx" ON "sticky"."stickies" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "sticky_state_guild_id_idx" ON "sticky"."sticky_state" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "stickies_guild_isolation" ON "sticky"."stickies" AS PERMISSIVE FOR ALL TO public USING ("sticky"."stickies"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("sticky"."stickies"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "sticky_state_guild_isolation" ON "sticky"."sticky_state" AS PERMISSIVE FOR ALL TO public USING ("sticky"."sticky_state"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("sticky"."sticky_state"."guild_id" = current_setting('app.guild_id', true));