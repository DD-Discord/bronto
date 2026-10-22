# Editing a sticky

## Changing the text

Edit the sticky's template. The sticky's post changes in place, with no repost.

When a template is deleted, the stickies that use it are deleted too. A template cannot be deleted while a sticky uses it: the delete is refused and names the channels.

## Changing the sticky

`/sticky edit channel` changes a sticky. Give only what should change.

- `template` switches the sticky to another template.
- `ignore-bots`, `silent` and `debounce` change how it reposts. See Options.

## Older stickies

Stickies created before templates existed are moved into templates automatically when the bot starts. Each becomes a template named `Sticky #<channel>`. Only the first embed is kept.

Until a sticky has moved, it keeps posting its old copy. The move is retried at the next start.
