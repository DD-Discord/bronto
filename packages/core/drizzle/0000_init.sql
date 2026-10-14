CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TABLE "core"."guild_modules" (
	"module" text NOT NULL,
	"enabled" boolean NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "guild_modules_guild_id_module_pk" PRIMARY KEY("guild_id","module")
);
--> statement-breakpoint
ALTER TABLE "core"."guild_modules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."guilds" (
	"id" text PRIMARY KEY NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "core"."guild_modules" ADD CONSTRAINT "guild_modules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guild_modules_guild_id_idx" ON "core"."guild_modules" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "guild_modules_guild_isolation" ON "core"."guild_modules" AS PERMISSIVE FOR ALL TO public USING ("core"."guild_modules"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("core"."guild_modules"."guild_id" = current_setting('app.guild_id', true));