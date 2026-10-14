import test from "node:test";
import assert from "node:assert/strict";
import { migrateFavorites } from "../src/model.ts";

test("legacy group favorites become a folder with one tab favorite per tab", () => {
  let next = 0;
  const legacy = {
    id: "g1", kind: "group", name: "前端",
    group: { id: "live", name: "前端", color: "#ff9ecf" },
    tabs: [
      { paths: ["/code/api"], title: "API", groupId: "live", favoriteId: "x", command: "npm run dev" },
      { paths: ["/code/web", "/code/web/docs"] },
    ],
    activeIndex: 0,
  };
  const plain = { id: "t1", kind: "tab", name: "notes", tab: { paths: ["/notes"] } };
  const result = migrateFavorites([plain, legacy], () => `new-${next++}`);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.folders, [{ id: "g1", kind: "folder", name: "前端", color: "#ff9ecf" }]);
  assert.deepEqual(result.favorites.map((item) => [item.id, item.name, item.groupId]), [["t1", "notes", undefined], ["new-0", "API", "g1"], ["new-1", "web", "g1"]]);
  assert.equal(result.favorites[1].tab.command, "npm run dev");
  assert.equal("groupId" in result.favorites[1].tab, false);
  assert.equal("favoriteId" in result.favorites[1].tab, false);
  assert.deepEqual(result.favorites[2].tab.paths, ["/code/web", "/code/web/docs"]);
});

test("current favorites pass through unchanged and orphaned group links are cleared", () => {
  const folder = { id: "f", kind: "folder", name: "工作", color: "#7cc4ff" };
  const inFolder = { id: "a", kind: "tab", name: "a", tab: { paths: ["/a"] }, groupId: "f" };
  const orphan = { id: "b", kind: "tab", name: "b", tab: { paths: ["/b"] }, groupId: "gone" };
  const clean = migrateFavorites([folder, inFolder], () => "unused");
  assert.equal(clean.migrated, false);
  assert.deepEqual(clean.favorites, [inFolder]);
  const fixed = migrateFavorites([folder, orphan], () => "unused");
  assert.equal(fixed.migrated, true);
  assert.equal("groupId" in fixed.favorites[0], false);
});

test("a linked tab shows the favorite name, otherwise its title, then the directory", async () => {
  const { displayName, unlinkedTitle } = await import("../src/model.ts");
  assert.equal(displayName("收藏名", "終端機標題", "dir"), "收藏名");
  assert.equal(displayName(undefined, "終端機標題", "dir"), "終端機標題");
  assert.equal(displayName(undefined, undefined, "dir"), "dir");
  assert.equal(unlinkedTitle("收藏名", undefined), "收藏名");
  assert.equal(unlinkedTitle("收藏名", "終端機標題"), "收藏名");
  assert.equal(unlinkedTitle(undefined, "自訂"), "自訂");
});
