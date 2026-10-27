# Sticky API

For module developers whose module works with stickies. `@bronto/sticky` exports an API, a collector and two events. Add it to your module's `dependsOn` first.

```ts
import sticky from '@bronto/sticky';

const api = ctx.modules.get(sticky);
```

Make API calls outside your own `ctx.db.run`. Each call runs in the guild of the calling handler.

## API

| Call | Returns |
|---|---|
| `exists(channelId)` | Whether the channel or thread has a sticky in this server. |
| `refresh(channelId)` | Re-renders the sticky's live post in place from its template and the collected rows (see below), without reposting it. Does nothing when the channel has no sticky or the sticky has no live post yet. |

The type `StickyApi` is exported too.

## Adding buttons: the `components` collector

Every post of a sticky can carry button rows from other modules. Sticky asks `stickyAsks.components` with `{ channelId }` before each post and each edit, and appends the rows below the template's message.

```ts
import { answer, defineModule } from '@bronto/core';
import sticky, { stickyAsks } from '@bronto/sticky';
import { ButtonStyle, ComponentType } from 'discord.js';

export default defineModule({
  name: 'vote',
  dependsOn: [sticky],
  listeners: [
    answer(stickyAsks.components, () => [
      { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: 'vote:up', label: 'Vote' }] },
    ]),
  ],
});
```

- **Answer:** an array of action rows (`APIActionRowComponent[]`), each with one to five buttons (buttons only); `[]` adds nothing. Other answers are skipped.
- **Rejected rows:** a row that passes this check can still break Discord's rules (a label over 80 characters, a button without `custom_id`, duplicate custom IDs). When Discord rejects a post or edit with rows, sticky logs a warning and posts it once more without them.
- **Order:** rows follow module order.
- **Limit:** a message holds five rows. Sticky keeps the first five and logs a warning for the rest.
- **Fail open:** a listener that throws, answers invalidly or takes longer than 1.5 s is skipped; the post goes out with the other rows.
- **Staying current:** posts and template edits ask again, so a module that stopped contributing loses its rows at the next one. Call `refresh(channelId)` to update the live post right away, e.g. when your module's state for the channel changed. Don't call it from inside your `components` answer for the same channel: the answer runs inside that channel's queue task, so the refresh would wait behind it and loop.
- **Webhook:** only a webhook owned by the bot can carry buttons. When rows are present and the sticky's webhook belongs to another application or was created by hand, sticky replaces it with its own at the next post.

Buttons handled by your module go in your module's `components`, as usual.

## Events

Listen to them with `on(...)` in `listeners`.

| Event | Payload | Emitted when |
|---|---|---|
| `stickyEvents.posted` | `{ channelId: string; messageId: string }` | A sticky was posted again. |
| `stickyEvents.deleted` | `{ channelId: string }` | A sticky was deleted: by `/sticky delete`, because its template was deleted or because its channel or thread was deleted. |
