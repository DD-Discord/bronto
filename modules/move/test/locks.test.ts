import { describe, expect, it } from 'vitest';
import { ChannelLocks } from '../src/locks.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('ChannelLocks', () => {
  it('runs overlapping moves one after another in order', async () => {
    const locks = new ChannelLocks();
    const order: string[] = [];
    const waited: string[] = [];
    const first = await locks.acquire(['a', 'b'], () => waited.push('first'));
    const second = locks.acquire(['b', 'c'], () => waited.push('second')).then((release) => (order.push('second'), release));
    const third = locks.acquire(['b'], () => waited.push('third')).then((release) => (order.push('third'), release));
    await tick();
    expect(order).toEqual([]);
    expect(waited).toEqual(['second', 'third']);
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(['second', 'third']);
    // Every lock is free again.
    const again = await locks.acquire(['a', 'b', 'c'], () => waited.push('again'));
    again();
    expect(waited).not.toContain('again');
  });

  it('takes keys in sorted order', async () => {
    const locks = new ChannelLocks();
    const holdA = await locks.acquire(['a'], () => {});
    // Waits on "a" before taking "b", so "b" stays free meanwhile.
    const both = locks.acquire(['b', 'a'], () => {});
    await tick();
    let bTaken = false;
    const onlyB = await locks.acquire(['b'], () => {
      bTaken = true;
    });
    expect(bTaken).toBe(false);
    onlyB();
    holdA();
    (await both)();
  });

  it('a release runs once', async () => {
    const locks = new ChannelLocks();
    const release = await locks.acquire(['a'], () => {});
    const next = locks.acquire(['a'], () => {});
    const after = locks.acquire(['a'], () => {});
    release();
    release();
    const nextRelease = await next;
    let afterDone = false;
    void after.then(() => (afterDone = true));
    await tick();
    expect(afterDone).toBe(false);
    nextRelease();
    (await after)();
  });
});
