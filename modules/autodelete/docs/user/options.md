# Autodelete options

`/autodelete create` and `/autodelete edit` take these options.

- `enabled` (default yes): whether the rule applies.
- `keep-latest` (default yes): a member's older post is removed when they post again.
- `delete-on-leave` (default no): a member's posts are removed when they leave the server.
- `cooldown` (default `0s`, off): time before a member may post again. Write a duration like `14d` or `1h 30m`.
- `grace` (default `0s`, off): deleting a post within this time after posting resets the cooldown. Write a duration like `1h`.
- `notify-dm` (default no): the member gets a copy of a removed post by direct message.
- `log-channel`: where reports go. Pick a text or announcement channel, or a public, private or announcement thread. Rules logging to the same channel share one webhook.
