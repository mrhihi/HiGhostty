import test from "node:test";
import assert from "node:assert/strict";
import { onGroupRemoved, popDetail, pushDetail, togglePanel } from "../src/drawer.ts";

const initial = () => ({ panel: null, lastPanel: "workspace", detailStack: [] });

test("switching panels closes detail and toggling the open panel closes all", () => {
  let state = togglePanel(initial(), "workspace");
  state = pushDetail(state, { kind: "group", groupId: "g1" });
  state = togglePanel(state, "favorites");
  assert.equal(state.panel, "favorites");
  assert.deepEqual(state.detailStack, []);
  assert.equal(togglePanel(state, "favorites").panel, null);
});

test("popping the last detail closes the second drawer", () => {
  const state = popDetail(pushDetail(togglePanel(initial(), "workspace"), { kind: "group", groupId: "g1" }));
  assert.deepEqual(state.detailStack, []);
});

test("removing a group clears its detail", () => {
  const state = pushDetail(togglePanel(initial(), "workspace"), { kind: "group", groupId: "g1" });
  assert.deepEqual(onGroupRemoved(state, "g1").detailStack, []);
});

