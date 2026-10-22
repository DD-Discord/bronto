# @bronto/sticky

Keeps a message at the bottom of a channel or thread: whenever someone posts, the sticky is deleted and posted again below the new message. A sticky posts a template from `@bronto/templates` through a webhook and follows the template: when someone edits the template, the post in the channel is edited in place, and when the template is deleted, the sticky is deleted too.

- Using `/sticky`: run `/help` in Discord and pick Sticky.
- Loading the module and its permissions: [docs/admin/setup.md](docs/admin/setup.md)
- Events for other modules: [docs/api/events.md](docs/api/events.md)
