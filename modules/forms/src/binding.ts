// Discord lets a bot edit an ephemeral reply for 15 minutes; editor components live as long.
export const EDITOR_TTL_MS = 15 * 60_000;

/** Binding of the components in ephemeral editor replies. */
export const editorBinding = { bind: { user: true, channel: true }, expiresAfterMs: EDITOR_TTL_MS, ephemeral: true } as const;
