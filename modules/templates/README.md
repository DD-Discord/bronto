# @bronto/templates

Message templates (text and one embed) that live as posts in a forum channel. Members with access create and edit
templates in Discord; other modules read them through an API. The sticky module uses it for its messages.

Each template is one forum post. The post's starter message is the preview: the content and embed as they will be
posted, with **Edit**, **Export**, **Import** and **Delete** buttons.

## Setup

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

## Commands

`/templates` needs Administrator by default.

| Command | What it does |
|---|---|
| `/templates init` | Creates the template forum. Refuses, with a link, while the stored forum still exists |
| `/templates list` | Lists the templates with links to their posts (only you see the reply) |

Everything else happens in the forum.

## Creating a template

Create a new post in the forum. The bot reads it, creates its own post with the same title and tags, and deletes
yours.

- **Title** is the template's name. Renaming the post renames the template.
- **Body** becomes the template's content, unless it is
  - JSON `{ "content": "…", "embeds": [ { … } ] }`: content and the first embed are imported, or
  - a link to a Discord message: its content and first embed are imported, and its image attachments are copied,
    since Discord's attachment links expire.
- Attachments in the body are ignored.

If something goes wrong (a bad link, an invalid embed, missing permissions), the bot replies in your post with the
reason and leaves it in place.

## Editing

Click **Edit** on the preview. The editor is a private message with a section per part of the message:

- **Content**: the text.
- **Body**: title, description, URL and color of the embed.
- **Author**: name, the link on the name, icon.
- **Footer**: text, icon, and the time of posting, filled in whenever the template is posted.
- **Images**: the image and the thumbnail.
- **Fields**: pick one to change it, move it (position) or remove it (clear name and value); **Add field** adds one,
  up to 25.
- **Remove embed** removes the embed. It is refused while the template has no content, since a template always
  keeps something to show.

Images can be given as a URL or uploaded in the modal. An upload replaces a URL for the same image; clearing both
removes the image. Only image files are accepted, within the bot's upload limit. Uploaded images are stored on the
preview message and their links are refreshed when needed.

The bot checks Discord's limits (6000 characters across the embed, 256 for a title, and so on). When something is
invalid you get the reason and a **Try again** button that reopens the form with what you typed. After a save the
preview is updated; if two people save the same section, the later save wins. The editor closes after 15 minutes;
click **Edit** again.

## Export and import

- **Export** replies with a `.json` file, `{ "content": …, "embeds": [ … ] }`.
- **Import** opens a form with a text box and a file upload for the same JSON, and replaces the template's content
  and embed.

## Deleting

**Delete** asks for confirmation. Other modules may veto the deletion (for example because a sticky still uses the
template); their reasons are shown. Otherwise the template and its post are deleted.

Deleting the post in Discord deletes the template. Deleting the forum deletes all of its templates. The module also
checks at startup and removes templates whose posts no longer exist. A failed check (missing access, Discord outage)
never deletes anything.

## API for other modules

Declare `dependsOn` for the module and get the API with `ctx.modules.get(templates)`. Make API calls outside your own
`ctx.db.run`.

```ts
import templates from '@bronto/templates';

const api = ctx.modules.get(templates);
```

| Call | Returns |
|---|---|
| `render(id)` | `{ content, embed }` ready to post, with uploaded image links refreshed and the time of posting filled in; `null` if the template doesn't exist |
| `get(id)` | `{ id, name, url }` with the post link; `null` if missing |
| `search(query)` | `{ id, name, createdAt }[]` for templates whose name contains the query (any case), at most 25, for autocomplete |
| `create({ id?, name, content, embed })` | `{ id }` of a new template and its post. A caller-chosen UUID makes retries safe: an existing template with that ID is returned. Creates the forum when there is none |

Events (`templatesEvents`), which carry only the template's ID:

- `updated`: after each saved change to content or embed (a rename doesn't fire it).
- `deleted`: after a template is deleted, however that happened.

Gate `deleting` (`templatesGates`): run by the Delete button before a template is deleted. A module that uses
templates can deny it with a reason.

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages and
posts are left in place. `bronto delete-guild` deletes stored server data immediately without removing Discord resources.
