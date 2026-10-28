CREATE SCHEMA "autoreact";
--> statement-breakpoint
CREATE TABLE "autoreact"."rules" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"ignore_bots" boolean DEFAULT true NOT NULL,
	"emojis" text[] NOT NULL,
	"ignored_user_ids" text[] DEFAULT '{}' NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "autoreact"."rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "autoreact"."rules" ADD CONSTRAINT "rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_guild_id_idx" ON "autoreact"."rules" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "rules_guild_isolation" ON "autoreact"."rules" AS PERMISSIVE FOR ALL TO public USING ("autoreact"."rules"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("autoreact"."rules"."guild_id" = current_setting('app.guild_id', true));