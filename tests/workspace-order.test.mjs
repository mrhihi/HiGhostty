import test from "node:test";
import assert from "node:assert/strict";
import { dissolveGroup, moveGroupedItem, moveItemBefore, orderGroupedItems, recentFavoriteInstance } from "../src/model.ts";

test("workspace rows follow ungrouped then group order and preserve within-group order", () => {
  const items = [
    { id: "b2", groupId: "b" },
    { id: "loose" },
    { id: "a1", groupId: "a" },
    { id: "orphan", groupId: "deleted" },
    { id: "b1", groupId: "b" },
  ];
  assert.deepEqual(orderGroupedItems(items, ["a", "b"]).map((item) => item.id), ["loose", "orphan", "a1", "b2", "b1"]);
});

test("moving a row reorders it and changes only its group membership", () => {
  const items = [
    { id: "a", groupId: "one", command: "echo keep" },
    { id: "b", groupId: "two", command: "pwd" },
    { id: "c", groupId: "two" },
  ];
  const moved = moveGroupedItem(items, "a", "two", "c");
  assert.deepEqual(moved.map((item) => item.id), ["b", "a", "c"]);
  assert.equal(moved[1].groupId, "two");
  assert.equal(moved[1].command, "echo keep");
  const loose = moveGroupedItem(moved, "a", null);
  const ungrouped = loose.find((item) => item.id === "a");
  assert.equal("groupId" in ungrouped, false);
  assert.equal(ungrouped.command, "echo keep");
});

test("dissolving a group preserves each tab's settings", () => {
  const items = [
    { id: "a", groupId: "g", command: "make", title: "Build" },
    { id: "b", groupId: "other", command: "pwd" },
  ];
  assert.deepEqual(dissolveGroup(items, "g"), [
    { id: "a", command: "make", title: "Build" },
    { id: "b", groupId: "other", command: "pwd" },
  ]);
});

test("opening a favorite selects its most recent linked instance", () => {
  const instances = [
    { id: "first", favoriteId: "fav" },
    { id: "other", favoriteId: "different" },
    { id: "last", favoriteId: "fav" },
  ];
  assert.equal(recentFavoriteInstance(instances, "fav", "first").id, "first");
  assert.equal(recentFavoriteInstance(instances, "fav").id, "last");
});

test("group order can be rearranged without changing its members", () => {
  const groups = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
  const moved = moveItemBefore(groups, "c", "a");
  assert.deepEqual(moved.map((group) => group.id), ["c", "a", "b"]);
  assert.equal(moved[0].name, "C");
});
