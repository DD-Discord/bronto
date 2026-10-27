import type { HandlerContext } from '@bronto/core';

/** The context forms handlers run with. */
export type FormsContext = HandlerContext<Record<string, never>>;
