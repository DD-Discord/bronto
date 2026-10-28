ALTER TABLE "forms"."submissions" ADD COLUMN "rest_channel_id" text;--> statement-breakpoint
-- Earlier versions posted every part to the submissions channel.
UPDATE "forms"."submissions" SET "rest_channel_id" = "channel_id" WHERE cardinality("part_message_ids") >= 2;