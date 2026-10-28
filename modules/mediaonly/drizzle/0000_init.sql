CREATE SCHEMA "mediaonly";
--> statement-breakpoint
CREATE TABLE "mediaonly"."rules" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"ignore_bots" boolean DEFAULT true NOT NULL,
	"require_spoiler" boolean DEFAULT false NOT NULL,
	"log_channel_id" text,
	"log_thread_id" text,
	"log_webhook_id" text,
	"log_webhook_token" text,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "mediaonly"."rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mediaonly"."rules" ADD CONSTRAINT "rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_guild_id_idx" ON "mediaonly"."rules" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "rules_guild_isolation" ON "mediaonly"."rules" AS PERMISSIVE FOR ALL TO public USING ("mediaonly"."rules"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("mediaonly"."rules"."guild_id" = current_setting('app.guild_id', true));