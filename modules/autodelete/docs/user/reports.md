# Reports and DMs

Reports go to the rule's log channel as messages sent as the member, with their display name and avatar. There are three kinds.

- **Replaced an older post** (amber): what changed from the old post to the new one, and when the old one was posted.
- **Held back a new post** (red): the cooldown ran until the shown time and the new post was removed. The diff compares it to the member's current post, and a button leads to that post.
- **Removed the post of a member who left** (gray): the removed text, and when the member joined and posted.

Reports also say when a post was already gone, when the bot could not delete it (it needs Manage Messages) and when the member's DMs are closed. Times are shown in each reader's own time zone. Nothing in a report pings anyone.

---

With `notify-dm`, a member whose post was held back or replaced gets a copy of it by direct message.

## Diffs and long posts

Diffs and copies show changed lines with one line of context. Texts too long for one message go into attachments, `changes.diff` and `post.txt`. A post with only attachments is reported as the number of attachments.

If the log webhook was deleted, the bot creates a new one once and resends the report. If that fails, the report is dropped with a warning in the bot's log.

## Privacy

The bot stores IDs and timestamps only: which message belongs to which member, and when a member last posted. It never stores message text or usernames. The text of a post is fetched from Discord right before it is removed. Webhook tokens are never shown or logged.
