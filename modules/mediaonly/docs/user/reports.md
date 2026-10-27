# Notices, DMs and reports

When a post fails the rule, the bot removes it and then:

- **Notice:** posts a short message in the channel that mentions the poster and says why. It is deleted again after 10 seconds. Only the poster is pinged.
- **DM:** sends the poster which channel it was, why, and a copy of their text so they can post again. Texts too long for one message come as `post.txt`. Attachments aren't copied.
- **Report:** with a log channel, sends a report as the poster, with their display name and avatar: who posted where, why it was removed, the removed text and the number of attachments. Nothing in a report pings anyone.

Reports also say when the poster's DMs are closed, and when the bot couldn't delete the post (it needs Manage Messages). Then there is no notice and no DM.

If the log webhook was deleted, the bot creates a new one once and resends the report. If that fails, the report is dropped with a warning in the bot's log.

## Privacy

The bot stores only the rule settings and the report webhook. It never stores message text. Webhook tokens are never shown or logged.
