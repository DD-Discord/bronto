# Templates

Message templates with text and one embed, kept as posts in a forum channel.

Each template is one forum post. The post's first message is the preview: the content and embed as they will be posted, with **Edit**, **Export**, **Import** and **Delete** buttons. Other modules, such as Sticky, post your templates. Anyone who may post in the forum can create and change templates.

`/templates` needs Administrator by default. Everything else happens in the forum.

> [!section] [Open](create.md)
> **Creating a template**
> Start a new post in the forum.

> [!section] [Open](edit.md)
> **Editing**
> The editor behind the **Edit** button.

> [!section] [Open](transfer.md)
> **Export and import**
> Move a template as JSON.

> [!section] [Open](delete.md)
> **Deleting**
> The **Delete** button, and what else removes a template.

## Commands

- `/templates init` creates the template forum. It refuses, with a link, while the stored forum still exists.
- `/templates list` lists the templates with links to their posts. Only you see the reply.
