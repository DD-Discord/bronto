import type { FakeRestAnswer } from '../rest.js';

const messages: Record<number, string> = {
  10003: 'Unknown Channel',
  50024: 'Cannot execute action on this channel type',
  50083: 'Thread is archived',
};
export const error = (code: number, status = 404): FakeRestAnswer => ({
  status, json: { code, message: messages[code] ?? `Synthetic Discord error ${code}` },
});
export const ok = (json: unknown): FakeRestAnswer => ({ status: 200, json });
export const gone = (): FakeRestAnswer => ({ status: 204, json: null });
