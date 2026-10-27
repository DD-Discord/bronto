# Sticky options

`/sticky create` and `/sticky edit` take these options.

- `ignore-bots` (default yes): messages from bots and system messages, such as joins, pins and boosts, do not move the sticky.
- `silent` (default yes): reposts do not notify anyone.
- `debounce` (default `0s`): the sticky waits until the channel has been quiet this long before it reposts. Write a duration like `30s` or `1h 30m`. The longest is `1d`.
