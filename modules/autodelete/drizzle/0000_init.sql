CREATE SCHEMA "autodelete";
--> statement-breakpoint
CREATE TABLE "autodelete"."cooldowns" (
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message_id" text,
	"posted_at" timestamp with time zone,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text,
	CONSTRAINT "cooldowns_guild_id_channel_id_user_id_pk" PRIMARY KEY("guild_id","channel_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "autodelete"."cooldowns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "autodelete"."posts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "autodelete"."posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "autodelete"."rules" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"keep_latest" boolean DEFAULT true NOT NULL,
	"delete_on_leave" boolean DEFAULT false NOT NULL,
	"cooldown_ms" bigint DEFAULT 0 NOT NULL,
	"grace_ms" bigint DEFAULT 0 NOT NULL,
	"notify_dm" boolean DEFAULT false NOT NULL,
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
ALTER TABLE "autodelete"."rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "autodelete"."cooldowns" ADD CONSTRAINT "cooldowns_channel_id_rules_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "autodelete"."rules"("channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autodelete"."cooldowns" ADD CONSTRAINT "cooldowns_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autodelete"."posts" ADD CONSTRAINT "posts_channel_id_rules_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "autodelete"."rules"("channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autodelete"."posts" ADD CONSTRAINT "posts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autodelete"."rules" ADD CONSTRAINT "rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "core"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cooldowns_guild_id_idx" ON "autodelete"."cooldowns" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "posts_guild_id_idx" ON "autodelete"."posts" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "posts_member_idx" ON "autodelete"."posts" USING btree ("guild_id","channel_id","user_id");--> statement-breakpoint
CREATE INDEX "rules_guild_id_idx" ON "autodelete"."rules" USING btree ("guild_id");--> statement-breakpoint
CREATE POLICY "cooldowns_guild_isolation" ON "autodelete"."cooldowns" AS PERMISSIVE FOR ALL TO public USING ("autodelete"."cooldowns"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("autodelete"."cooldowns"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "posts_guild_isolation" ON "autodelete"."posts" AS PERMISSIVE FOR ALL TO public USING ("autodelete"."posts"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("autodelete"."posts"."guild_id" = current_setting('app.guild_id', true));--> statement-breakpoint
CREATE POLICY "rules_guild_isolation" ON "autodelete"."rules" AS PERMISSIVE FOR ALL TO public USING ("autodelete"."rules"."guild_id" = current_setting('app.guild_id', true)) WITH CHECK ("autodelete"."rules"."guild_id" = current_setting('app.guild_id', true));