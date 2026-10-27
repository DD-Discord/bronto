# Building a form

Start a new post in the forms forum. Its title becomes the form's name. The bot replaces your post with its own, which holds the form: the settings, the numbered list of fields and the buttons below.

## Fields

**Add field** asks for a type and then opens a pop-up. When you save it, the bot shows the field with a summary of all its settings and buttons to change it. **Edit field** picks a field and shows the same view.

The pop-up has the same inputs for every type: a **label** (45 characters), an optional **description** (100), a **Required** checkbox and a **position**. Leave the position blank to add a field at the end or keep its place. Select menus, radio buttons and checkboxes also have an **Options** box with one option per line; options are at most 100 characters and must be different from each other.

The types and their extra settings:

- **Short text** and **Long text**: up to 4000 characters. **Text limits** sets a placeholder (shown inside the empty box), a minimum length and a maximum length. Leave a number blank for no limit.
- **Select menu**: a dropdown with 1 to 25 options. **Choice limits** sets the fewest and the most choices a member may pick; blank uses the default.
- **Radio buttons**: 2 to 10 options. A member picks exactly one, so there are no extra settings.
- **Checkboxes**: 1 to 10 options, with **Choice limits** like the select menu.
- **File upload**: **File settings** sets the most files (1 to 10, one by default) and the allowed types, comma separated, such as `image, video, .txt, .md`. Leave the types blank to allow any type.

The extra settings are separate pop-ups so that each value has its own input. If a value is not valid, the bot says which and offers **Try again** with what you typed.

Text fields hold up to 4000 characters. For longer entries, add a file upload field and let members attach a document. Uploaded files must fit the server's upload limit.

Removing a field keeps the answers already submitted. Members fill in five fields per pop-up, so a long form is shown in pages.

## Settings

The **Settings** button opens one pop-up:

- **Name** of the form.
- **Submissions channel**: where answers are posted. Leave it empty to post them in the form's own post, which is where a new form sends them.
- **Pings**: up to 25 users and roles together. They are pinged by the first message of each submission. You can only pick roles you may mention, and not @everyone.
- **Allowed roles**: only these roles can fill in the form. Empty means everyone.
- **Active**: members can fill in the form only while this is checked.
- **One submission per member**.

## Trying it

**Try it** walks you through the form as a member would, without posting anything. Your trial answers are not saved.

## Export and import

**Export** sends the form as a `.json` file. **Import** takes pasted JSON or an uploaded `.json` file and replaces the settings and all fields. Use it to copy a form to another server or to keep a backup.

## Deleting

**Delete** asks for confirmation and deletes the form, its post and its stored submissions. It is refused while buttons for the form exist; the message names the channels. Remove the buttons with `/forms buttons` first.

A form is also deleted when its post is deleted in Discord, and all forms are deleted when the forum is. Buttons for a deleted form go with it.
