# Deleting a template

**Delete** asks for confirmation. Other modules may veto the deletion, for example because a sticky still uses the template. Their reasons are shown. Otherwise the template and its post are deleted.

A template is also deleted when its post or the forum is removed.

- Deleting the post in Discord deletes the template.
- Deleting the forum deletes all of its templates.
- At startup the bot removes templates whose posts no longer exist. A failed check (missing access, Discord outage) never deletes anything.
