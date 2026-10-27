# Putting a form in a channel

Members open a form from a button. `/forms post` adds one.

## Options

- `channel` is where the button goes: a text, announcement or voice channel, or a thread.
- `form` is the form to open.
- `label` is the button text, up to 80 characters. The default is the form's name.
- `template` posts a message from that template with the button under it.
- `message` is a link to an earlier message with form buttons in the channel. The new button joins it.

Without `template` and `message`, the button goes on the channel's sticky. This needs the sticky module and a sticky that already exists in the channel; create one with `/sticky create` first. The sticky is refreshed with the button and keeps it as it reposts.

A message or sticky holds up to 25 form buttons, five to a row. A sticky also shares its space with the buttons of other modules.

## Inactive forms

A button for an inactive form is shown greyed out. Switch the form on in **Settings** and the button works again.

## Looking at and removing buttons

`/forms buttons` takes a channel and lists its form buttons: label, form and whether it is on the sticky or on a message. A menu below the list removes one. Removing the last button on a message that forms posted deletes that message.

## What removes buttons

- Deleting the form's post, or the forms forum, in Discord removes the form and its buttons.
- Deleting a sticky removes its form buttons.
- A template that form buttons use cannot be deleted. The refusal names the channels.

Deleting a form from its post is refused while buttons exist, so remove them first.
