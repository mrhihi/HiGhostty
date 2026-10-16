import test from "node:test";
import assert from "node:assert/strict";
import { dissolveGroup, moveGroupedItem, moveItemBefore, orderGroupedItems, orderTabsByFavorites, recentFavoriteInstance } from "../src/model.ts";

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

test("grouped tabs follow favorite order regardless of which tabs are open", () => {
  const favorites = [{ id: "f1", groupId: "g" }, { id: "f2", groupId: "g" }, { id: "f3", groupId: "g" }];
  const ids = (tabs) => orderTabsByFavorites(tabs, favorites, ["g"]).map((tab) => tab.id);
  assert.deepEqual(ids([{ id: "t3", favoriteId: "f3" }, { id: "t1", favoriteId: "f1" }]), ["t1", "t3"]);
  assert.deepEqual(ids([{ id: "t1", favoriteId: "f1" }, { id: "t3", favoriteId: "f3" }, { id: "t2", favoriteId: "f2" }]), ["t1", "t2", "t3"]);
  assert.deepEqual(ids([{ id: "x" }, { id: "t2", favoriteId: "f2" }, { id: "y", favoriteId: "gone" }, { id: "t2b", favoriteId: "f2" }]), ["x", "y", "t2", "t2b"]);
});

test("orderTabsByFavorites: ungrouped favorite tabs follow favorite order, plain tabs stay first", () => {
  const tabs = [{ id: "t1", favoriteId: "b" }, { id: "t2" }, { id: "t3", favoriteId: "a" }];
  const favorites = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(orderTabsByFavorites(tabs, favorites, []).map((tab) => tab.id), ["t2", "t3", "t1"]);
});

import { insertPosition } from "../src/row-drag.ts";
test("insertPosition counts the rows above the dragged row", () => {
  assert.equal(insertPosition([10, 40, 70], 5), 0);
  assert.equal(insertPosition([10, 40, 70], 50), 2);
  assert.equal(insertPosition([10, 40, 70], 90), 3);
});
