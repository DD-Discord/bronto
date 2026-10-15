CREATE SCHEMA "notes";
--> statement-breakpoint
CREATE TABLE "notes"."notes" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "notes"."notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notes"."notes" ADD CONSTRAINT "notes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_guild_id_idx" ON "notes"."notes" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "notes_guild_isolation" ON "notes"."notes" AS PERMISSIVE FOR ALL TO public USING ("notes"."notes"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("notes"."notes"."guild_id" = current_setting('app.guild_id', true));