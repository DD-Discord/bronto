# Creating a template

Create a new post in the forum. The bot reads it, creates its own post with the same title and tags, and deletes yours.

- **Title** is the template's name. Renaming the post renames the template.
- **Body** becomes the template's content, unless it is JSON `{ "content": "…", "embeds": [ { … } ] }` or a link to a Discord message.
- Attachments in the body are ignored.

With JSON, the content and the first embed are imported.

With a link to a Discord message, its content and first embed are imported, and its image attachments are copied, since Discord's attachment links expire.

If something goes wrong (a bad link, an invalid embed, missing permissions), the bot replies in your post with the reason and leaves it in place.
