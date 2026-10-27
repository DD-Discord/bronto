# Sticky events

`@bronto/sticky` exports `stickyEvents`. Listen to them with `on(...)` after adding `sticky` to `dependsOn`.

| Event | Payload | Emitted when |
|---|---|---|
| `stickyEvents.posted` | `{ channelId: string; messageId: string }` | A sticky was posted again. |
