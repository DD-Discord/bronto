# Setting up a rule

`/mediaonly set` creates the rule of a channel, or changes only the options you give when it has one. Without `channel` it uses the channel you are in.

- `channel`: a text or announcement channel, or a thread. A forum post is a thread, so a rule can cover a single post. Forum channels themselves can't have a rule. A rule covers only the channel or thread it names, not the threads of a rule channel.
- `require-spoiler` (default no): every attachment must be marked as spoiler and every link wrapped in `||`.
- `log-channel`: where reports go. Pick a text or announcement channel, or a thread. Rules logging to the same channel share one webhook.
- `remove-log-channel`: stops reports.
- `enabled` (default yes): whether the rule applies.
- `ignore-bots` (default yes): posts of bots and webhooks are left alone. A sticky's own post and the bot's own posts are always left alone.

A post passes when it has at least one attachment of any kind (images, videos, audio, other files) or at least one link starting with `http://` or `https://`. Link previews aren't checked. A forwarded message counts by what it forwards.

## Other commands

- `/mediaonly show` shows a rule. Without `channel` it shows the rule of the channel you are in.
- `/mediaonly list` lists the rules of this server.
- `/mediaonly remove` removes a rule. It also deletes the rule's report webhook, unless another rule shares it.

A rule is removed when its channel or thread is deleted.
