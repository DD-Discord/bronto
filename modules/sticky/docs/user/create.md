# Creating a sticky

`/sticky create channel template` creates a sticky and posts it right away. The sticky posts a template, so write the text as a template first.

- `channel` is the channel or thread that gets the sticky.
- `template` is the template to post. Start typing its name and pick it from the list.
- `ignore-bots`, `silent` and `debounce` are optional. See Options.

## Where stickies work

Stickies work in text, announcement and voice channels and in threads.

In a private thread the bot must be added to the thread or have Manage Threads.

## What the post looks like

Mentions in a template show up as mentions but never ping anyone.

If someone deletes the webhook the sticky posts through, a new one is created on the next repost. The same happens when buttons are added to a sticky whose webhook belongs to another application or was created by hand, since only the bot's own webhook can carry buttons.
