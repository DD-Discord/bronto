import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { Progress } from '../src/mover.js';

const apiError = (code: number, status: number) => new DiscordAPIError({ code, message: 'Synthetic' }, code, status, 'PATCH', 'https://example.test', {});

/** A confirmation whose edits fail with `failures` in turn, then succeed. */
function confirmation(...failures: unknown[]) {
  const edits: string[] = [];
  const logs: { fields: Record<string, unknown>; message: string }[] = [];
  const ctx = {
    update: async ({ content }: { content: string }) => {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      edits.push(content);
    },
    log: { info: (fields: Record<string, unknown>, message: string) => void logs.push({ fields, message }) },
  };
  return { progress: new Progress(ctx as never), edits, logs };
}

describe('Progress', () => {
  it('skips an edit that fails for another reason and keeps editing', async () => {
    const { progress, edits, logs } = confirmation(apiError(0, 500));
    await progress.show('Moved 1 of 2…', true);
    await progress.show('Moved 2 of 2…', true);
    await progress.finish('Done.');
    expect(edits).toEqual(['Moved 2 of 2…', 'Done.']);
    expect(logs.filter((line) => 'result' in line.fields)).toEqual([]);
  });

  it.each([
    ['an invalid webhook token', apiError(RESTJSONErrorCodes.InvalidWebhookToken, 401)],
    ['an unknown webhook', apiError(RESTJSONErrorCodes.UnknownWebhook, 404)],
    ['an unknown interaction', apiError(RESTJSONErrorCodes.UnknownInteraction, 404)],
    ['HTTP 401', apiError(0, 401)],
  ])('stops editing after %s and logs the result', async (_name, error) => {
    const { progress, edits, logs } = confirmation(error);
    await progress.show('Moved 1 of 2…', true);
    await progress.show('Moved 2 of 2…', true);
    await progress.finish('Done.', { truncated: false, lists: { stayed: ['https://example.test/1 (poll)'] } });
    expect(edits).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ fields: { result: 'Done.', lists: { stayed: ['https://example.test/1 (poll)'] } } }));
  });

  it('logs the full lists when the result was cut short', async () => {
    const { progress, edits, logs } = confirmation();
    const lists = { stayed: Array.from({ length: 3 }, (_, index) => `https://example.test/${index} (poll)`) };
    await progress.finish('Cut.', { truncated: true, lists });
    expect(edits).toEqual(['Cut.']);
    expect(logs).toContainEqual(expect.objectContaining({ fields: { result: 'Cut.', lists } }));
  });
});
