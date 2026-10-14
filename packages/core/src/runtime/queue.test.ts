import { describe, expect, it, vi } from 'vitest';
import { KeyedQueue } from './queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('KeyedQueue', () => {
  it('runs a task right away when its key is idle', async () => {
    const queue = new KeyedQueue(() => undefined);
    const ran: string[] = [];
    await queue.run('a', async () => {
      ran.push('a');
    });
    expect(ran).toEqual(['a']);
  });

  it('runs tasks of one key one after another', async () => {
    const queue = new KeyedQueue(() => undefined);
    const gate = deferred();
    const order: string[] = [];
    const first = queue.run('k', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = queue.run('k', async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('runs different keys in parallel', async () => {
    const queue = new KeyedQueue(() => undefined);
    const gate = deferred();
    const order: string[] = [];
    const slow = queue.run('a', async () => {
      await gate.promise;
      order.push('a');
    });
    await queue.run('b', async () => {
      order.push('b');
    });
    expect(order).toEqual(['b']);
    gate.resolve();
    await slow;
    expect(order).toEqual(['b', 'a']);
  });

  it('collapses a burst into the running task and the newest request', async () => {
    const queue = new KeyedQueue(() => undefined);
    const gate = deferred();
    const ran: string[] = [];
    const running = queue.run('k', async () => {
      await gate.promise;
      ran.push('A');
    });
    const b = queue.run('k', async () => {
      ran.push('B');
    });
    const c = queue.run('k', async () => {
      ran.push('C');
    });
    const d = queue.run('k', async () => {
      ran.push('D');
    });
    gate.resolve();
    await Promise.all([running, b, c, d]);
    expect(ran).toEqual(['A', 'D']);
  });

  it('reports a failing task and keeps going', async () => {
    const onError = vi.fn();
    const queue = new KeyedQueue(onError);
    const error = new Error('boom');
    const ran: string[] = [];
    const failing = queue.run('k', async () => {
      throw error;
    });
    const next = queue.run('k', async () => {
      ran.push('next');
    });
    await expect(failing).resolves.toBeUndefined();
    await next;
    expect(onError).toHaveBeenCalledWith('k', error);
    expect(ran).toEqual(['next']);
  });

  it('becomes idle once every key is drained', async () => {
    const queue = new KeyedQueue(() => undefined);
    const gate = deferred();
    let done = false;
    void queue.run('k', async () => {
      await gate.promise;
      done = true;
    });
    const idle = queue.idle();
    gate.resolve();
    await idle;
    expect(done).toBe(true);
  });

  it('keeps a key usable when the error handler throws', async () => {
    const queue = new KeyedQueue(() => {
      throw new Error('handler broke');
    });
    const ran: string[] = [];
    await queue.run('k', async () => {
      throw new Error('boom');
    });
    await queue.run('k', async () => {
      ran.push('after');
    });
    expect(ran).toEqual(['after']);
  });

  it('reuses a key after it drained', async () => {
    const queue = new KeyedQueue(() => undefined);
    const ran: string[] = [];
    await queue.run('k', async () => {
      ran.push('first');
    });
    await queue.idle();
    await queue.run('k', async () => {
      ran.push('second');
    });
    expect(ran).toEqual(['first', 'second']);
  });
});
