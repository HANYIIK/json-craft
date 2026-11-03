import assert from "node:assert/strict";
import test from "node:test";
import { createCopyFeedback } from "../../../src/renderer/components/copy-feedback";

function fixture() {
  const changes: boolean[] = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  let sequence = 0;
  const feedback = createCopyFeedback((copied) => changes.push(copied), {
    schedule: ((run: () => void, delay: number) => {
      timers.set(++sequence, { at: now + delay, run });
      return sequence;
    }) as unknown as typeof setTimeout,
    cancel: ((id: number) =>
      timers.delete(id)) as unknown as typeof clearTimeout,
  });
  function tick(ms: number) {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.run();
    }
  }
  return { feedback, changes, timers, tick };
}

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("copy feedback starts only after success and expires after two seconds", async () => {
  const { feedback, changes, tick } = fixture();
  const held = deferred();
  const copying = feedback.copy(() => held.promise);
  tick(4_000);
  assert.deepEqual(changes, []);
  held.resolve(true);
  assert.equal(await copying, true);
  assert.deepEqual(changes, [true]);
  tick(1_999);
  assert.deepEqual(changes, [true]);
  tick(1);
  assert.deepEqual(changes, [true, false]);
});

test("each successful repeated click restarts the timer from its completion", async () => {
  const { feedback, changes, tick, timers } = fixture();
  await feedback.copy(() => true);
  tick(1_500);
  await feedback.copy(() => Promise.resolve(true));
  assert.equal(timers.size, 1);
  tick(500);
  assert.deepEqual(changes, [true]);
  tick(1_499);
  assert.deepEqual(changes, [true]);
  tick(1);
  assert.deepEqual(changes, [true, false]);
});

test("false and rejected copies never show success and clear an earlier success", async () => {
  const { feedback, changes, timers } = fixture();
  assert.equal(await feedback.copy(() => false), false);
  assert.equal(
    await feedback.copy(() => Promise.reject(new Error("denied"))),
    false,
  );
  assert.deepEqual(changes, []);
  await feedback.copy(() => true);
  await feedback.copy(() => false);
  assert.deepEqual(changes, [true, false]);
  assert.equal(timers.size, 0);
});

test("an older failed attempt cannot clear a newer successful copy", async () => {
  const { feedback, changes, tick } = fixture();
  const older = deferred();
  const pending = feedback.copy(() => older.promise);
  await feedback.copy(() => true);
  older.reject(new Error("earlier copy failed"));
  await pending;
  assert.deepEqual(changes, [true]);
  tick(2_000);
  assert.deepEqual(changes, [true, false]);
});

test("changing file or output invalidates old copies and clears its previous feedback", async () => {
  const { feedback, changes, timers } = fixture();
  await feedback.copy(() => true);
  const held = deferred();
  const pending = feedback.copy(() => held.promise);
  feedback.reset();
  assert.deepEqual(changes, [true, false]);
  assert.equal(timers.size, 0);
  held.resolve(true);
  await pending;
  assert.deepEqual(changes, [true, false]);
  await feedback.copy(() => true);
  assert.deepEqual(changes, [true, false, true]);
});

test("different buttons keep independent feedback and unmount cancels timers and pending callbacks", async () => {
  const first = fixture();
  const second = fixture();
  await first.feedback.copy(() => true);
  assert.deepEqual(second.changes, []);
  const held = deferred();
  const pending = first.feedback.copy(() => held.promise);
  first.feedback.dispose();
  assert.equal(first.timers.size, 0);
  held.resolve(true);
  await pending;
  first.tick(5_000);
  assert.deepEqual(first.changes, [true]);
  await second.feedback.copy(() => true);
  assert.deepEqual(second.changes, [true]);
});
