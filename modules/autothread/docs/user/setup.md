# Setting up a rule

`/autothread set` creates the rule of a channel, or changes only the options you give when it has one. Without `channel` it uses the channel you are in.

- `channel`: a text or announcement channel. Forum posts are threads already, and threads can't have threads.
- `name-format` (default `[Comments] {user.display}`): the name of each thread. Placeholders such as `{user.display}` are filled in from the post; the Placeholders page of Templates in `/help` lists them. Date and time placeholders other than `{date.iso}` don't work in thread names and are refused. Names are cut to 100 characters, and a blank name becomes `Comments`.
- `slowmode` (default off): slowmode of the new threads, for example `30s`; `0s` turns it off. At most 6 hours.
- `auto-message`: a template posted as the first message of each thread. Placeholders in the template are filled in, and only the post's author is pinged, for example through `{user.mention}`. Pick it from the list as you type.
- `remove-auto-message`: stop posting a first message. If the template was deleted anyway, threads are still opened.
- `rename` (default no): lets the post's author rename the thread.
- `enabled` (default yes): whether the rule applies.
- `ignore-bots` (default yes): posts of bots and webhooks get no thread. A sticky's own post and the bot's own posts never do.

A template that a rule uses can't be deleted. A post that Mediaonly removes gets no thread.

## Other commands

- `/autothread show` shows a rule. Without `channel` it shows the rule of the channel you are in.
- `/autothread list` lists the rules of this server.
- `/autothread remove` removes a rule.

A rule is removed when its channel is deleted.
