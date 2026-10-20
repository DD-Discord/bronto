import type { FakeRestAnswer } from '../rest.js';

export const error = (code: number, status = 404): FakeRestAnswer => ({
  status, json: { code, message: `Synthetic Discord error ${code}` },
});
export const ok = (json: unknown): FakeRestAnswer => ({ status: 200, json });
export const gone = (): FakeRestAnswer => ({ status: 204, json: null });
