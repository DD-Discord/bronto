# Forms setup

- Load `@bronto/templates` as well; forms depend on it. Load `@bronto/sticky` too if form buttons should go on
  stickies; without it, buttons go on template messages only. Load `@bronto/autothread` and `@bronto/autoreact` to
  have submissions follow the submissions channel's rules: the first message gets the reactions and a thread, and a
  long submission continues in that thread.
- Templates needs the **Message Content** intent (see its setup); forms itself needs no privileged intent.
- Forum channels need a **Community** server. Turn on Community in Server Settings first; `/forms init` refuses on
  other servers.
- Give the bot these permissions (a server-wide role covers it):

  | Permission | Needed for |
  |---|---|
  | View Channel, Read Message History | reading new posts, refetching uploaded files |
  | Send Messages, Send Messages in Threads | creating posts and posting submissions |
  | Manage Threads | deleting your post after the bot moves it; locking the `drafts` post, reopening it when archived and posting in it while locked |
  | Manage Channels | `/forms init` |
  | Attach Files, Embed Links | submissions with files |

  The bot also needs to post in each submissions channel and in each channel that gets a form button.

- Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/templates": {}
    "@bronto/sticky": {}      # optional: form buttons on stickies
    "@bronto/autothread": {}  # optional: threads on submissions
    "@bronto/autoreact": {}   # optional: reactions on submissions
    "@bronto/forms": {}
  ```

- Run `/forms init`. It creates a forum named `forms`, hidden from @everyone (the bot can see it). Rename it, move it
  or open it to your form editors in Discord. Anyone who may post in the forum can create and change forms. The
  bot also keeps a `drafts` post in it for files members upload before they submit; leave it alone.
- `/forms` needs Administrator by default.
- Forms are inactive until someone switches them on in **Settings**.
- Uploaded files must fit the upload limit of the server (it depends on the server's boost level).

## Data

Drafts are deleted 24 hours after the last saved page, and swept hourly.

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages and
posts are left in place. `bronto delete-guild` deletes stored server data immediately without removing Discord resources.
