import { useLocale } from "./i18n-helper.mjs"; useLocale();
import test from "node:test";
import assert from "node:assert/strict";
import {
  split,
  leaves,
  remove,
  rectangles,
  dividers,
  ratioFromDrag,
  neighbor,
  resizeSplit,
  equalize,
  orderWithChildren,
  promoteChildren,
  nextCopyName,
} from "../src/model.ts";
test("copy names increment the largest matching suffix", () => {
  assert.equal(nextCopyName("工作區", ["工作區", "工作區(1)", "工作區(3)", "工作區外(8)"]), "工作區(4)");
  assert.equal(nextCopyName("工作區(2)", ["工作區", "工作區(2)", "工作區(5)"]), "工作區(6)");
  assert.equal(nextCopyName("a.b", ["aXb(9)", "a.b(2)"]), "a.b(3)");
});
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

test("sub-tabs follow their root and promotion keeps a single level", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "a1", parentId: "a" }, { id: "a2", parentId: "a" }, { id: "x", parentId: "gone" }];
  assert.deepEqual(orderWithChildren(tabs).map((t) => t.id), ["a", "a1", "a2", "b", "x"]);
  const head = promoteChildren(tabs, "a");
  assert.equal(head.id, "a1");
  assert.equal(head.parentId, undefined);
  assert.equal(tabs.find((t) => t.id === "a2").parentId, "a1");
  assert.equal(promoteChildren(tabs, "b"), undefined);
});

test("dividers sit in the gaps between panes and dragging maps pointer to ratio", () => {
  const tree = split(split({ kind: "leaf", id: "a" }, "a", "b", 0), "b", "c", 1);
  const rects = rectangles(tree, 10, 20, 1000, 700);
  const ds = dividers(tree, 10, 20, 1000, 700);
  assert.equal(ds.length, 2);
  const a = rects.find((r) => r.id === "a");
  assert.equal(ds[0].axis, "row");
  assert.equal(ds[0].x, a.x + a.width);
  const b = rects.find((r) => r.id === "b");
  assert.equal(ds[1].axis, "column");
  assert.equal(ds[1].y, b.y + b.height);
  assert.equal(ds[1].x, b.x);
  assert.equal(ratioFromDrag(ds[0], ds[0].start + 3 + ds[0].span * 0.25), 0.25);
  assert.equal(ratioFromDrag(ds[0], -500), 0.1);
  assert.equal(ratioFromDrag(ds[0], 5000), 0.9);
});
