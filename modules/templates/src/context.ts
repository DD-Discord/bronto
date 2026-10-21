import type { HandlerContext } from '@bronto/core';

/** The context templates handlers and API calls run with. */
export type TemplatesContext = HandlerContext<Record<string, never>>;
