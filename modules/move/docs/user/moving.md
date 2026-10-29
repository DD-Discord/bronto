# Moving messages

`/move` reposts a range of messages in another channel or thread and deletes the originals. Only you see its replies.

- `from`: a link to the first message to move. Use "Copy Message Link" in a message's menu.
- `to`: a link to the last message to move. Without it, only the `from` message moves. Both links must point to the same channel, and either may be the older one.
- `target`: the text channel, announcement channel or thread the messages go to.

A move covers at most 200 messages, system messages included. You and the bot need access to both places: you need Manage Messages in the source and permission to post in the target, and the bot needs Manage Messages there too, plus the right to manage webhooks in the target. If something is missing, `/move` names it. Messages in an archived thread can't be moved; unarchive the thread first.

## Confirming

`/move` first shows the source, the target, the first and last message and how many messages will move and how many stay behind. Press **Move** to go ahead or **Cancel**. The confirmation expires after 5 minutes, and it only works for you. While the move runs, the message shows its progress. Moves in the same channel wait for each other.

## What carries over

- The text, posted under the author's server nickname (or name) and avatar. A repost shows a bot tag.
- Files, spoilers and stickers. A sticker becomes a `Sticker: <name>` line, plus its image when it can be attached.
- Embeds of bots and webhooks, with the files they show.
- Link buttons.
- Reactions: each emoji once, added by the bot. Custom emojis only when the bot can use them.
- Replies: a line above the repost points to the replied message with a short excerpt of it, or says the message was deleted.
- Forwarded messages: their text is quoted under a "Forwarded" line, with their files, embeds and stickers.

Messages over 2000 characters are split into several posts, and more than 10 files go out as extra posts after the message. Reposts are silent: they ping nobody and never notify.

## What doesn't carry over

- Reaction counts and who reacted.
- Poll votes.
- Pins.
- The "edited" mark.
- The time of the message. A repost shows the time of the move.

## Messages that stay behind

Some messages can't be moved faithfully. They stay in the source channel and a copy goes to the target with a note and a link to the original:

- Messages with an attachment too large for the bot to upload, also one an embed shows.
- Polls, also forwarded ones.
- Messages that have a thread.
- The first message of a forum post.
- Interactive messages: any message with buttons or menus other than link buttons, new-style component messages, forwarded messages with buttons or menus, and sticky posts.

When a reaction can't be added to a copy, its original stays behind too and is listed in the result; the copy keeps the reactions that could be added.

When Discord refuses a message, for example because an embed is invalid, that message stays behind without a copy and the move goes on. If the move fails for another reason, for example the bot loses access to the target, the copies already posted are removed and nothing is deleted. The result lists every message that stayed behind or couldn't be deleted.

Other system messages in the range, such as pin notices, are deleted with it. A "thread started" notice, and the starter message shown at the top of a thread, are always kept.

## A move can't be undone

The originals are deleted. To bring messages back, move them again from the target.
