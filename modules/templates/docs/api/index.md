# Templates API

For module developers whose module uses templates. `@bronto/templates` exports an API, two events and a gate. Add it to your module's `dependsOn` first.

```ts
import templates from '@bronto/templates';

const api = ctx.modules.get(templates);
```

Declare it in your module definition with `dependsOn: [templates]`.

Make API calls outside your own `ctx.db.run`. Each call runs in the guild of the calling handler.

## API

| Call | Returns |
|---|---|
| `render(id)` | `{ content, embed }` ready to post, with uploaded image links refreshed and the time of posting filled in; `null` if the template doesn't exist |
| `get(id)` | `{ id, name, url }` with the post link; `null` if missing |
| `search(query)` | `{ id, name, createdAt }[]` for templates whose name contains the query (any case), at most 25, for autocomplete |
| `create({ id?, name, content, embed })` | `{ id }` of a new template and its post. A caller-chosen UUID makes retries safe: an existing template with that ID is returned. Creates the forum when there is none |

Template IDs are UUIDs. `render` and `get` return `null` for an ID that is not one, and `create` throws.

The types `TemplatesApi`, `TemplateMessage`, `Template`, `TemplateImage` and `ImageSlot` are exported too.

## Events

`templatesEvents` carry only the template's ID, `{ id: string }`. Listen to them with `on(...)` in `listeners`, e.g. `on(templatesEvents.updated, (ctx, { id }) => …)`.

| Event | Emitted when |
|---|---|
| `templatesEvents.updated` | After each saved change to content or embed. A rename doesn't fire it. |
| `templatesEvents.deleted` | After a template is deleted, however that happened. |

## Gates

| Gate | Payload | Asked when |
|---|---|---|
| `templatesGates.deleting` | `{ id: string }` | The Delete button is pressed, before the template is deleted. |

Register a handler in `listeners` with `gate(...)`. Return `{ deny: 'reason' }` to veto the deletion; the reason is shown to the person deleting. Return nothing to allow it.

```ts
gate(templatesGates.deleting, async (ctx, { id }) => {
  if (await isUsed(ctx, id)) return { deny: 'Used by …' };
}),
```
