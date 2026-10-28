# Placeholders

Some modules fill in placeholders when they post a template, for example the automatic message of a thread. Write a placeholder in the template's text, title, description, field names and values, footer or author name.

- `{user.mention}` mentions the member
- `{user.name}` is the member's username
- `{user.display}` is the member's display name on this server
- `{channel.mention}` links the channel
- `{channel.name}` is the channel's name
- `{server.name}` is the server's name
- `{message.link}` links the message

When the message was posted:

- `{date}` like 28 October 2026
- `{date.short}` like 28/10/2026
- `{time}` like 13:14
- `{datetime}` like 28 October 2026 13:14
- `{date.relative}` like 2 minutes ago
- `{date.iso}` like 2026-10-28, in UTC

All but `{date.iso}` show in each reader's own time zone and language. They only work in message text: in a thread name they show as raw code, so use `{date.iso}` there.

Text that is not a placeholder, or a placeholder the module does not know, stays as you wrote it. Filled text that grows beyond Discord's limits is cut and ends in `…`.

Placeholders only work where a module fills them in. In the template's own preview and wherever a module posts the template as it is, they show as written.
