# Showing and deleting stickies

## Show

`/sticky show` shows the sticky of a channel. Without `channel` it shows the sticky of the channel you are in. Only you see the answer.

## List

`/sticky list` lists the stickies of this server, with the template each one posts. Only you see the answer.

## Delete

`/sticky delete channel` deletes a sticky and its post. The webhook it posted through is deleted as well, unless another sticky shares it.

## Leaving the server

When the bot leaves a server, its sticky data is kept for 30 days and then deleted. Messages already posted stay in the channels.
