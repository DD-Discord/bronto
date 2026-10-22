ALTER TABLE "sticky"."stickies" ALTER COLUMN "template_channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ALTER COLUMN "template_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ALTER COLUMN "content" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ALTER COLUMN "embeds" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ALTER COLUMN "embeds" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ADD COLUMN "template_id" text;--> statement-breakpoint
UPDATE "sticky"."stickies" SET "template_id" = gen_random_uuid()::text WHERE "template_id" IS NULL;--> statement-breakpoint
ALTER TABLE "sticky"."stickies" ALTER COLUMN "template_id" SET NOT NULL;