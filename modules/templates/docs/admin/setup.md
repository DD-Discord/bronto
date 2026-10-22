# Templates setup

- Enable the **Message Content** intent for your application in the Discord developer portal; the module reads the
  body of new posts.
- Forum channels need a **Community** server. Turn on Community in Server Settings first; `/templates init` refuses
  on other servers.
- Give the bot these permissions in the template forum (a server-wide role covers it):

  | Permission | Needed for |
  |---|---|
  | View Channel, Read Message History | reading new posts, refetching image links |
  | Send Messages, Send Messages in Threads | creating posts and replies |
  | Manage Threads | deleting your post after the bot moves it |
  | Manage Channels | `/templates init` |
  | Attach Files, Embed Links | uploads and the preview |

- Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/templates": {}
  ```

- Run `/templates init` in the server. It creates a forum named `templates`, hidden from @everyone (the bot can see it).
  Rename it, move it or open it to your editors in Discord as you like. Anyone who may post in the forum can create
  and change templates.
- `/templates` needs Administrator by default.

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages and
posts are left in place. `bronto delete-guild` deletes stored server data immediately without removing Discord resources.
