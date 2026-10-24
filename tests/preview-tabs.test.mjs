import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PANES, activePane, importGroups, canMerge, movePane, closeGroup, closePane, detachPane, dropTarget, emptyTabs, groupTitle, mergeGroups,
  moveGroup, openPath, paneBoxes, paneCount, replacePanePath, setLayout, sizesFromDrag, splitGroup,
} from "../src/preview-tabs.ts";

const three = () => {
  let s = emptyTabs();
  for (const p of ["/a/a.md", "/a/b.md", "/a/c.md"]) s = openPath(s, p);
  return s;
};

test("openPath adds a tab and activates it; the same file only activates", () => {
  let s = openPath(emptyTabs(), "/a/a.md");
  s = openPath(s, "/a/b.md");
  assert.equal(s.groups.length, 2);
  assert.equal(s.active, s.groups[1].id);
  const again = openPath(s, "/a/a.md");
  assert.equal(again.groups.length, 2);
  assert.equal(again.active, s.groups[0].id);
});

test("mergeGroups joins up to three panes and refuses a fourth", () => {
  let s = three();
  const [a, b, c] = s.groups.map((g) => g.id);
  const ab = mergeGroups(s, b, a);
  assert.ok("state" in ab);
  assert.equal(ab.state.groups.length, 2);
  assert.equal(groupTitle(ab.state.groups[0]), "a.md ｜ b.md");
  assert.equal(ab.state.active, a);
  assert.deepEqual(ab.state.groups[0].sizes.map((x) => +x.toFixed(3)), [0.5, 0.5]);
  const abc = mergeGroups(ab.state, c, a);
  assert.ok("state" in abc);
  assert.equal(abc.state.groups[0].panes.length, MAX_PANES);
  s = openPath(abc.state, "/a/d.md");
  const d = s.groups[1].id;
  assert.deepEqual(mergeGroups(s, d, a), { error: "tooMany" });
  assert.equal(canMerge(s, d, a), false);
  const fresh = three();
  assert.equal(canMerge(fresh, fresh.groups[1].id, fresh.groups[0].id), true);
  assert.deepEqual(mergeGroups(s, a, a), { error: "missing" });
});

test("splitGroup and detachPane turn panes back into tabs", () => {
  const s = three();
  const [a, b, c] = s.groups.map((g) => g.id);
  const merged = mergeGroups(mergeGroups(s, b, a).state, c, a).state;
  const split = splitGroup(merged, a);
  assert.equal(split.groups.length, 3);
  assert.equal(paneCount(split), 3);
  const paneB = merged.groups[0].panes[1].id;
  const detached = detachPane(merged, paneB);
  assert.equal(detached.groups.length, 2);
  assert.equal(groupTitle(detached.groups[0]), "a.md ｜ c.md");
  assert.equal(groupTitle(detached.groups[1]), "b.md");
  assert.equal(detached.active, detached.groups[1].id);
  assert.equal(detachPane(s, s.groups[0].panes[0].id), s); // a single pane has nothing to leave
});

test("closing picks the right neighbour and drops a tab with its last pane", () => {
  let s = three();
  const [a, b, c] = s.groups.map((g) => g.id);
  s = { ...s, active: b };
  assert.equal(closeGroup(s, b).active, c);
  assert.equal(closeGroup({ ...s, active: c }, c).active, b);
  assert.equal(closeGroup(s, a).active, b); // closing a background tab keeps the active one
  assert.equal(closeGroup(closeGroup(closeGroup(s, a), b), c).groups.length, 0);
  const merged = mergeGroups(s, b, a).state;
  const paneA = merged.groups[0].panes[0].id;
  const closed = closePane(merged, paneA);
  assert.equal(closed.groups[0].panes.length, 1);
  assert.deepEqual(closed.groups[0].sizes, [1]);
  assert.equal(closePane(s, s.groups[2].panes[0].id).groups.length, 2);
});

test("moveGroup reorders; setLayout resets sizes; replacePanePath swaps the file", () => {
  const s = three();
  const [a, b, c] = s.groups.map((g) => g.id);
  assert.deepEqual(moveGroup(s, c, 0).groups.map((g) => g.id), [c, a, b]);
  assert.deepEqual(moveGroup(s, a, 99).groups.map((g) => g.id), [b, c, a]);
  const m = mergeGroups(s, b, a).state;
  const uneven = { ...m, groups: m.groups.map((g) => (g.id === a ? { ...g, sizes: [0.8, 0.2] } : g)) };
  const rows = setLayout(uneven, a, "rows");
  assert.equal(rows.groups[0].layout, "rows");
  assert.deepEqual(rows.groups[0].sizes, [0.5, 0.5]);
  assert.equal(setLayout(rows, a, "rows"), rows);
  const paneId = m.groups[0].panes[1].id;
  assert.equal(groupTitle(replacePanePath(m, paneId, "/a/z.md").groups[0]), "a.md ｜ z.md");
});

test("paneBoxes splits the area with gaps in both directions", () => {
  const area = { x: 10, y: 20, width: 1012, height: 600 };
  const cols = paneBoxes(area, "columns", [1 / 3, 1 / 3, 1 / 3]);
  assert.equal(cols.length, 3);
  assert.equal(cols[0].x, 10);
  assert.equal(cols[0].width, 1000 / 3);
  assert.ok(Math.abs(cols[1].x - (10 + 1000 / 3 + 6)) < 1e-9);
  assert.ok(Math.abs(cols[2].x + cols[2].width - 1022) < 1e-9);
  assert.ok(cols.every((b) => b.y === 20 && b.height === 600));
  const rows = paneBoxes({ x: 0, y: 0, width: 400, height: 306 }, "rows", [0.5, 0.5]);
  assert.deepEqual(rows.map((b) => [b.y, b.height]), [[0, 150], [156, 150]]);
  assert.ok(rows.every((b) => b.x === 0 && b.width === 400));
});

test("sizesFromDrag moves one divider, keeps the sum and the minimum", () => {
  const area = { x: 0, y: 0, width: 1012, height: 600 };
  const even = [1 / 3, 1 / 3, 1 / 3];
  const moved = sizesFromDrag(area, "columns", even, 0, 506);
  assert.ok(Math.abs(moved.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(moved[0] > 0.45 && moved[0] < 0.55);
  assert.ok(Math.abs(moved[2] - 1 / 3) < 1e-9); // the far pane is untouched
  const low = sizesFromDrag(area, "columns", even, 1, -500);
  assert.ok(low[1] >= 0.12 - 1e-9);
  const high = sizesFromDrag(area, "rows", [0.5, 0.5], 0, 99999);
  assert.ok(high[1] >= 0.12 - 1e-9);
  assert.deepEqual(sizesFromDrag(area, "columns", even, 2, 100), even);
});

test("dropTarget: middle merges, outer quarters reorder", () => {
  const rects = [{ left: 0, width: 100 }, { left: 100, width: 100 }];
  assert.deepEqual(dropTarget(rects, 50), { kind: "merge", index: 0 });
  assert.deepEqual(dropTarget(rects, 10), { kind: "move", index: 0 });
  assert.deepEqual(dropTarget(rects, 90), { kind: "move", index: 1 });
  assert.deepEqual(dropTarget(rects, 190), { kind: "move", index: 2 });
  assert.deepEqual(dropTarget(rects, 500), { kind: "move", index: 2 });
  assert.equal(dropTarget([], 5), undefined);
});

test("movePane swaps with a neighbour and the size goes along", () => {
  const s = three();
  const [a, b, c] = s.groups.map((g) => g.id);
  let m = mergeGroups(mergeGroups(s, b, a).state, c, a).state;
  m = { ...m, groups: m.groups.map((g) => ({ ...g, sizes: [0.5, 0.3, 0.2] })) };
  const first = m.groups[0].panes[0].id;
  const moved = movePane(m, first, 1);
  assert.equal(groupTitle(moved.groups[0]), "b.md ｜ a.md ｜ c.md");
  assert.deepEqual(moved.groups[0].sizes, [0.3, 0.5, 0.2]);
  assert.equal(movePane(m, first, -1), m); // already first
  const last = m.groups[0].panes[2].id;
  assert.equal(movePane(m, last, 1), m);
  assert.equal(groupTitle(movePane(m, last, -1).groups[0]), "a.md ｜ c.md ｜ b.md");
  assert.equal(activePane(m)?.path, "/a/a.md");
  assert.equal(activePane(emptyTabs()), undefined);
});

test("importGroups keeps popped-out tabs as they were and skips files already open", () => {
  let s = openPath(emptyTabs(), "/a/a.md");
  s = importGroups(s, [
    { paths: ["/a/a.md", "/a/b.md"], layout: "rows", sizes: [0.7, 0.3] },
    { paths: ["/a/c.md", "/a/d.md", "/a/e.md"] },
  ], 1, { window: "main", tab: "t1" });
  assert.equal(s.groups.length, 3);
  assert.equal(groupTitle(s.groups[1]), "b.md");     // a.md was already open
  assert.equal(s.groups[1].layout, "rows");
  assert.equal(groupTitle(s.groups[2]), "c.md ｜ d.md ｜ e.md");
  assert.equal(s.active, s.groups[2].id);
  assert.equal(s.groups[2].panes[0].origin.tab, "t1");
  assert.deepEqual(s.groups[2].sizes.map((x) => +x.toFixed(3)), [0.333, 0.333, 0.333]);
  assert.equal(importGroups(s, [{ paths: ["/a/a.md"] }]).groups.length, 3);
});
