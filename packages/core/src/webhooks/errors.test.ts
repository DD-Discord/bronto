import { expect, it } from 'vitest';
import { DiscordAPIError } from 'discord.js';
import { captureLog } from '../testing/log.js';
import { UnknownMessageError, UnknownWebhookError, withWebhookErrors } from './errors.js';
it.each([10015, 50027])('normalizes unusable webhook %i during operations', async code => {
  const error = new DiscordAPIError({ code, message: 'Unusable' }, code, 404, 'POST', '/x', {});
  await expect(withWebhookErrors('synthetic-token', async () => { throw error; })).rejects.toBeInstanceOf(UnknownWebhookError);
});
it('normalizes missing messages and sanitizes other errors before logging', async () => {
  const missing = new DiscordAPIError({ code: 10008, message: 'Unknown Message' }, 10008, 404, 'DELETE', '/x', {});
  await expect(withWebhookErrors('synthetic-token', async () => { throw missing; })).rejects.toBeInstanceOf(UnknownMessageError);
  const token = 'synthetic-secret-token';
  const error = new DiscordAPIError({ code: 50035, message: token }, 50035, 400, 'POST', `/webhooks/1/${token}`, { body: { content: 'synthetic-private-text', username: 'synthetic-private-name' }, files: [] });
  const captured = captureLog();
  await withWebhookErrors(token, async () => { throw error; }).catch(err => { expect(err.code).toBe(50035); captured.log.error({ err }); });
  const json = JSON.stringify(captured.lines);
  expect(json).not.toContain(token); expect(json).not.toContain('synthetic-private-text'); expect(json).not.toContain('synthetic-private-name');
});
