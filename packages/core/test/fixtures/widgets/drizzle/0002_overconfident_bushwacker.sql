CREATE TABLE "widgets"."rules" (
	"channel_id" text PRIMARY KEY NOT NULL,
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
ALTER TABLE "widgets"."rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "widgets"."rules" ADD CONSTRAINT "rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_guild_id_idx" ON "widgets"."rules" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "rules_guild_isolation" ON "widgets"."rules" AS PERMISSIVE FOR ALL TO public USING ("widgets"."rules"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("widgets"."rules"."guild_id" = current_setting('app.guild_id', true));