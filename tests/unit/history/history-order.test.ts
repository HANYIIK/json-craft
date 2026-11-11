import assert from "node:assert/strict";
import test from "node:test";
import { compareHistoryRecency } from "../../../src/renderer/features/history/history-order";

test("history ordering compares instants instead of timestamp strings and leaves new inputs first", () => {
  const records = [
    { id: "old", updatedAt: "2026-11-11T09:30:00+08:00" },
    { id: "new", updatedAt: "2026-11-11T02:00:00Z" },
    { id: "unsaved" },
    { id: "created", createdAt: "2026-11-11T01:45:00Z" },
  ];
  assert.deepEqual(
    [...records].sort(compareHistoryRecency).map((value) => value.id),
    ["unsaved", "new", "created", "old"],
  );
  assert.equal(records[0].id, "old");
});

test("equal history edit times have stable ID ordering", () => {
  assert.ok(compareHistoryRecency({ id: "a" }, { id: "b" }) < 0);
  assert.equal(compareHistoryRecency({ id: "a" }, { id: "a" }), 0);
});
