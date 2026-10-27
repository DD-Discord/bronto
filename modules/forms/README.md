# @bronto/forms

Forms that members fill in from a button in a channel. Each form is a post in a forum channel: you add fields, set where the answers go and who gets pinged, and put a button for it in any channel. Members answer in Discord's pop-up forms, and the submission appears in the channel you chose, with uploaded files attached.

Buttons go on a message made from a template of `@bronto/templates`, or on a channel's sticky when `@bronto/sticky` is loaded.

- Using and building forms: run `/help` in Discord and pick Forms.
- Loading the module and its permissions: [docs/admin/setup.md](docs/admin/setup.md)
- API: forms exports nothing for other modules, so there is no API page. It depends on `@bronto/templates` and uses `@bronto/sticky` when that is loaded.
