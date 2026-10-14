CREATE SCHEMA "widgets";
--> statement-breakpoint
CREATE TABLE "widgets"."items" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "widgets"."items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "widgets"."items" ADD CONSTRAINT "items_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_guild_id_idx" ON "widgets"."items" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "items_guild_isolation" ON "widgets"."items" AS PERMISSIVE FOR ALL TO public USING ("widgets"."items"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("widgets"."items"."guild_id" = current_setting('app.guild_id', true));