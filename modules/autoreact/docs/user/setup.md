# Setting up a rule

`/autoreact set` creates the rule of a channel, or changes only the options you give when it has one. Without `channel` it uses the channel you are in.

- `channel`: a text or announcement channel, or a thread. A forum post is a thread, so a rule can cover a single post. Forum channels themselves can't have a rule. A rule covers only the channel or thread it names, not the threads of a rule channel.
- `emojis`: one to five different emojis, separated by spaces or commas. They are added in the order you give. Use unicode emojis or custom emojis of a server the bot is in. Needed when you create a rule.
- `ignore-user`: a member whose posts get no reactions. Run the command again to ignore more members.
- `unignore-user`: takes a member off the ignored members.
- `enabled` (default yes): whether the rule applies.
- `ignore-bots` (default yes): posts of bots and webhooks get no reactions. A sticky's own post and the bot's own posts never do.

A post that Mediaonly removes gets no reactions. If a reaction can't be added, for example because its emoji was deleted, the others are still added.

## Other commands

- `/autoreact show` shows a rule. Without `channel` it shows the rule of the channel you are in.
- `/autoreact list` lists the rules of this server.
- `/autoreact remove` removes a rule.

A rule is removed when its channel or thread is deleted.
