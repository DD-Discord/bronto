CREATE SCHEMA "autothread";
--> statement-breakpoint
CREATE TABLE "autothread"."rules" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"ignore_bots" boolean DEFAULT true NOT NULL,
	"name_format" text DEFAULT '[Comments] {user.display}' NOT NULL,
	"slowmode_seconds" integer DEFAULT 0 NOT NULL,
	"template_id" text,
	"rename" boolean DEFAULT false NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "autothread"."rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "autothread"."rules" ADD CONSTRAINT "rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_guild_id_idx" ON "autothread"."rules" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "rules_guild_isolation" ON "autothread"."rules" AS PERMISSIVE FOR ALL TO public USING ("autothread"."rules"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("autothread"."rules"."guild_id" = current_setting('app.guild_id', true));