# Editing a template

Click **Edit** on the preview. The editor is a private message with a section per part of the message.

- **Content**: the text.
- **Body**: title, description, URL and color of the embed.
- **Author**: name, the link on the name, icon.
- **Footer**: text, icon, and the time of posting, filled in whenever the template is posted.
- **Images**: the image and the thumbnail.
- **Fields**: pick one to change it, move it (position) or remove it (clear name and value). **Add field** adds one, up to 25.
- **Remove embed** removes the embed. It is refused while the template has no content, since a template always keeps something to show.

---

## Images

Give an image as a URL or upload it in the form. An upload replaces a URL for the same image. Clearing both removes the image. Only image files are accepted, within the bot's upload limit. Uploaded images are stored on the preview message and their links are refreshed when needed.

## Saving

The bot checks Discord's limits (6000 characters across the embed, 256 for a title, and so on). When something is invalid you get the reason and a **Try again** button that reopens the form with what you typed.

After a save the preview is updated. If two people save the same section, the later save wins. The editor closes after 15 minutes. Click **Edit** again.
