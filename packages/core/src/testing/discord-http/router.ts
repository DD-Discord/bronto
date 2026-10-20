import type { FakeHttpAnswer, RecordedRequest } from '../rest.js';

type Params<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Record<Name, string> & Params<Rest>
  : Path extends `${string}:${infer Name}` ? Record<Name, string> : Record<never, string>;

type Handler<P> = (request: RecordedRequest, params: P) => ReturnType<FakeHttpAnswer>;

interface Route {
  method: string;
  segments: string[];
  answer: Handler<Record<string, string>>;
}

export function route<Path extends string>(method: string, path: Path, answer: Handler<Params<Path>>): Route {
  return {
    method,
    segments: path.split('/'),
    answer: (request, params) => answer(request, params as Params<Path>),
  };
}

/** Exact paths with named segments only. Registration order decides the first match. */
export function createRouter(routes: Route[]): FakeHttpAnswer {
  return async request => {
    const segments = request.path.split('/');
    for (const route of routes) {
      if (request.method !== route.method || segments.length !== route.segments.length) continue;
      const params: Record<string, string> = {};
      let matches = true;
      for (const [index, segment] of route.segments.entries()) {
        const value = segments[index]!;
        if (segment.startsWith(':') && value !== '') {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          matches = false;
          break;
        }
      }
      if (matches) return route.answer(request, params);
    }
    throw new Error(`Unexpected Discord request: ${request.method} ${request.path}`);
  };
}
