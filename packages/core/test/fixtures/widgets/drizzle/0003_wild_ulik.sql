CREATE TABLE "widgets"."forums" (
	"forum_channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "widgets"."forums" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "widgets"."posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"thread_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "posts_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
ALTER TABLE "widgets"."posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "widgets"."forums" ADD CONSTRAINT "forums_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widgets"."posts" ADD CONSTRAINT "posts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forums_guild_id_idx" ON "widgets"."forums" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forums_guild_id_key" ON "widgets"."forums" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "posts_guild_id_idx" ON "widgets"."posts" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "forums_guild_isolation" ON "widgets"."forums" AS PERMISSIVE FOR ALL TO public USING ("widgets"."forums"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("widgets"."forums"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "posts_guild_isolation" ON "widgets"."posts" AS PERMISSIVE FOR ALL TO public USING ("widgets"."posts"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("widgets"."posts"."guild_id" = current_setting('app.guild_id', true));