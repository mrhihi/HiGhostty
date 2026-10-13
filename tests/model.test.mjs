import test from "node:test";
import assert from "node:assert/strict";
import {
  split,
  leaves,
  remove,
  rectangles,
  neighbor,
  resizeSplit,
  equalize,
} from "../src/model.ts";
test("splitting and closing retain every other surface", () => {
  let tree = { kind: "leaf", id: "a" };
  tree = split(tree, "a", "b", 0);
  tree = split(tree, "b", "c", 1);
  assert.deepEqual(leaves(tree), ["a", "b", "c"]);
  const after = remove(tree, "b");
  assert.deepEqual(leaves(after), ["a", "c"]);
  assert.equal(remove(after, "a").id, "c");
  assert.equal(remove({ kind: "leaf", id: "a" }, "a"), undefined);
});
test("split layout fits its bounds and directional focus follows geometry", () => {
  const tree = split(
    split({ kind: "leaf", id: "a" }, "a", "b", 0),
    "b",
    "c",
    1,
  );
  const rects = rectangles(tree, 10, 20, 1000, 700);
  assert.equal(neighbor(rects, "a", 5), "b");
  assert.equal(neighbor(rects, "b", 4), "c");
  assert.equal(neighbor(rects, "c", 2), "b");
  assert.equal(neighbor(rects, "a", 3), undefined);
  for (const r of rects) {
    assert.ok(r.width > 0 && r.height > 0);
    assert.ok(r.x + r.width <= 1010);
    assert.ok(r.y + r.height <= 720);
  }
});
test("resizing selects the closest matching branch and clamps the ratio", () => {
  const tree = split(
    split({ kind: "leaf", id: "a" }, "a", "b", 0),
    "b",
    "c",
    1,
  );
  assert.equal(resizeSplit(tree, "c", 1, 20), true);
  assert.equal(tree.second.ratio, 0.9);
  assert.equal(tree.ratio, 0.5);
  equalize(tree);
  assert.equal(tree.second.ratio, 0.5);
  assert.equal(resizeSplit(tree, "a", 0, 0.1), false);
});
