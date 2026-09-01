import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveShardConfig, selectShard, shardsCoverEverything } from "./shard.mjs";

const UNITS = Array.from({ length: 93 }, (_, i) => `unit-${i}`);

test("shard config: defaults to running everything on one shard", () => {
  assert.deepEqual(resolveShardConfig({}), { count: 1, index: 1 });
});

test("shard config: reads a 1-based index", () => {
  assert.deepEqual(resolveShardConfig({ SHARD_COUNT: "4", SHARD_INDEX: "3" }), { count: 4, index: 3 });
});

test("shard config: clamps an index outside the count rather than quietly running nothing", () => {
  assert.deepEqual(resolveShardConfig({ SHARD_COUNT: "4", SHARD_INDEX: "9" }), { count: 4, index: 4 });
  assert.deepEqual(resolveShardConfig({ SHARD_COUNT: "4", SHARD_INDEX: "0" }), { count: 4, index: 1 });
});

test("shard config: survives nonsense without disabling itself silently", () => {
  assert.deepEqual(resolveShardConfig({ SHARD_COUNT: "banana" }), { count: 1, index: 1 });
});

test("selectShard: runs everything when there is one shard", () => {
  assert.deepEqual(selectShard(UNITS, { index: 1, count: 1 }), UNITS);
});

test("selectShard: covers every unit exactly once across all shards", () => {
  // The property that matters. A split that drops a suite is indistinguishable
  // from a suite that passed.
  for (const count of [2, 3, 4, 8]) {
    assert.equal(shardsCoverEverything(UNITS, count), true, `count ${count} lost or duplicated a unit`);
  }
});

test("selectShard: splits evenly enough that no shard carries the whole run", () => {
  const sizes = [1, 2, 3, 4].map((index) => selectShard(UNITS, { index, count: 4 }).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `uneven split: ${sizes.join(", ")}`);
});

test("selectShard: is stable for the same input", () => {
  assert.deepEqual(
    selectShard(UNITS, { index: 2, count: 4 }),
    selectShard(UNITS, { index: 2, count: 4 }),
  );
});

test("selectShard: handles fewer units than shards", () => {
  assert.deepEqual(selectShard(["only"], { index: 2, count: 4 }), []);
  assert.deepEqual(selectShard(["only"], { index: 1, count: 4 }), ["only"]);
});
