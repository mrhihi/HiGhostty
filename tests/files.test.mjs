import test from "node:test";
import assert from "node:assert/strict";
import {
  clampColumnWidth,
  clampPreviewHeight,
  columnChain,
  columnRootFor,
  DEFAULT_COLUMN_WIDTH,
  pruneColumnWidths,
  rememberColumnWidth,
  clampWidth,
  fileKindLabel,
  parentOf,
  previewTarget,
  formatSize,
  initialFiles,
  moveSelection,
  navigate,
  onCwd,
  pruneSelection,
  returnToCwd,
  select,
  shellQuote,
  sortEntries,
  stemLength,
  toggleExpanded,
  toggleFull,
  toggleOpen,
  topLevelPaths,
} from "../src/files.ts";
import { useLocale } from "./i18n-helper.mjs";
useLocale();

test("closing the panel also leaves full mode", () => {
  const state = toggleFull(initialFiles());
  assert.equal(state.open, true);
  assert.equal(state.full, true);
  assert.deepEqual(toggleOpen(state), { ...state, open: false, full: false });
});

test("the panel follows cwd until browsing elsewhere", () => {
  let state = onCwd(initialFiles(), "/a");
  assert.equal(state.path, "/a");
  state = navigate(state, "/a/b", "/a");
  assert.equal(state.follow, false);
  assert.equal(onCwd(state, "/c").path, "/a/b");
  state = returnToCwd(state, "/c");
  assert.equal(state.follow, true);
  assert.equal(state.path, "/c");
  // Browsing back to the cwd resumes following.
  assert.equal(navigate(navigate(state, "/", "/c"), "/c", "/c").follow, true);
});

test("collapsing a folder forgets nested expansions", () => {
  let state = toggleExpanded(initialFiles(), "/a");
  state = toggleExpanded(state, "/a/b");
  state = toggleExpanded(state, "/ab");
  assert.deepEqual(toggleExpanded(state, "/a").expanded, ["/ab"]);
});

test("selection supports toggle, range and arrow keys", () => {
  const order = ["a", "b", "c", "d"];
  let sel = select({ paths: [] }, "b", order);
  sel = select(sel, "d", order, { range: true });
  assert.deepEqual(sel.paths, ["b", "c", "d"]);
  sel = select(sel, "c", order, { toggle: true });
  assert.deepEqual(sel.paths, ["b", "d"]);
  assert.deepEqual(moveSelection({ paths: [] }, order, 1).paths, ["a"]);
  assert.deepEqual(moveSelection({ paths: [] }, order, -1).paths, ["d"]);
  assert.deepEqual(moveSelection({ paths: ["d"] }, order, 1).paths, ["d"]);
  const extended = moveSelection({ paths: ["b"], anchor: "b" }, order, 1, true);
  assert.deepEqual(extended.paths, ["b", "c"]);
  assert.deepEqual(moveSelection(extended, order, 1, true).paths, ["b", "c", "d"]);
  assert.deepEqual(pruneSelection({ paths: ["a", "x"], anchor: "x" }, order), { paths: ["a"], anchor: "a" });
});

test("folders sort first and names sort numerically", () => {
  const entry = (name, is_dir = false, size = 0) => ({ name, path: "/" + name, is_dir, is_symlink: false, size, modified_ms: 0, has_children: false });
  const entries = [entry("file10"), entry("file2"), entry("Zdir", true), entry("big", false, 9)];
  assert.deepEqual(sortEntries(entries, { key: "name", descending: false }).map((x) => x.name), ["Zdir", "big", "file2", "file10"]);
  assert.deepEqual(sortEntries(entries, { key: "size", descending: true }).map((x) => x.name), ["Zdir", "big", "file10", "file2"]);
});

test("rename selects the stem", () => {
  assert.equal(stemLength("archive.tar.gz", false), "archive.tar".length);
  assert.equal(stemLength("dir.d", true), 5);
});

test("helpers", () => {
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
  assert.equal(clampWidth(100, 1000), 240);
  assert.equal(clampWidth(900, 1000), 700);
  assert.equal(clampPreviewHeight(10, 800), 80);
  assert.equal(clampPreviewHeight(300, 800), 300);
  assert.equal(clampPreviewHeight(790, 800), 560);
  assert.equal(clampPreviewHeight(500, 60), 80);
  assert.equal(formatSize(512, false), "512 B");
  assert.equal(formatSize(12_300, false), "12 KB");
  assert.equal(formatSize(4_500_000, false), "4.5 MB");
  assert.deepEqual(topLevelPaths(["/a", "/a/b", "/ab"]), ["/a", "/ab"]);
});

test("parent paths and preview targets", () => {
  assert.equal(parentOf("/a/b"), "/a");
  assert.equal(parentOf("/a/b/"), "/a");
  assert.equal(parentOf("/a"), "/");
  assert.equal(parentOf("/"), "/");
  const entry = (path, is_dir) => ({ name: path.slice(1), path, is_dir, is_symlink: false, size: 0, modified_ms: 0, has_children: false });
  const entries = new Map([["/d", entry("/d", true)], ["/f", entry("/f", false)]]);
  assert.deepEqual(previewTarget({ paths: [] }, entries), { kind: "none" });
  assert.equal(previewTarget({ paths: ["/d"] }, entries).kind, "dir");
  assert.equal(previewTarget({ paths: ["/f", "/gone"] }, entries).kind, "file");
  assert.deepEqual(previewTarget({ paths: ["/d", "/f"] }, entries), { kind: "many", count: 2 });
  assert.equal(fileKindLabel("main.ts", false), "TS 檔案");
  assert.equal(fileKindLabel(".env", false), "檔案");
  assert.equal(fileKindLabel("x", true), "資料夾");
});

test("column root stays while going deeper and moves up past the left edge", () => {
  assert.equal(columnRootFor(undefined, "/a/b"), "/a");
  assert.equal(columnRootFor("/a", "/a/b"), "/a");
  assert.equal(columnRootFor("/a", "/a/b/c/d"), "/a");
  assert.equal(columnRootFor("/a", "/a"), "/");
  assert.equal(columnRootFor("/a/b", "/a/b"), "/a");
  assert.equal(columnRootFor("/a", "/x/y"), "/x");
  assert.equal(columnRootFor("/ab", "/abc/d"), "/abc");
  assert.equal(columnRootFor("/", "/a"), "/");
  assert.equal(columnRootFor("/", "/"), "/");
});

test("column chain runs from the root to the parent of the path", () => {
  assert.deepEqual(columnChain(undefined, "/a/b"), ["/a"]);
  assert.deepEqual(columnChain("/a", "/a/b/c/d"), ["/a", "/a/b", "/a/b/c"]);
  assert.deepEqual(columnChain("/a", "/a"), ["/"]);
  assert.deepEqual(columnChain("/x", "/a/b"), ["/a"]);
  assert.deepEqual(columnChain("/", "/a/b"), ["/", "/a"]);
  assert.deepEqual(columnChain("/", "/"), []);
  assert.deepEqual(columnChain(undefined, "/a"), ["/"]);
});

test("column widths clamp, skip the default and cap the memory", () => {
  assert.equal(clampColumnWidth(10), 120);
  assert.equal(clampColumnWidth(5000), 800);
  assert.deepEqual(rememberColumnWidth({}, "/a", 300), { "/a": 300 });
  assert.deepEqual(rememberColumnWidth({ "/a": 300 }, "/a", DEFAULT_COLUMN_WIDTH), {});
  const full = rememberColumnWidth({ "/a": 300, "/b": 310 }, "/a", 320, 2);
  assert.deepEqual(Object.keys(full), ["/b", "/a"]);
  assert.deepEqual(Object.keys(rememberColumnWidth(full, "/c", 330, 2)), ["/a", "/c"]);
});

test("pruning forgets widths of folders missing from the listing", () => {
  const dir = (path) => ({ name: path.split("/").pop(), path, is_dir: true });
  const widths = { "/a": 300, "/a/b": 310, "/a/b/c": 320, "/a/gone": 330, "/a/gone/x": 340, "/a/.hid": 350, "/other": 360 };
  const listing = [dir("/a/b")];
  assert.deepEqual(Object.keys(pruneColumnWidths(widths, "/a", listing, false)), ["/a", "/a/b", "/a/b/c", "/a/.hid", "/other"]);
  assert.deepEqual(Object.keys(pruneColumnWidths(widths, "/a", listing, true)), ["/a", "/a/b", "/a/b/c", "/other"]);
  assert.deepEqual(Object.keys(pruneColumnWidths(widths, "/a/gone", undefined, false)), ["/a", "/a/b", "/a/b/c", "/a/.hid", "/other"]);
  assert.equal(pruneColumnWidths(widths, "/other", [], false), widths);
});

test("saveFiles and restoreFiles keep path and expanded folders", async () => {
  const { saveFiles, restoreFiles, initialFiles, sameSaved } = await import("../src/files.ts");
  assert.equal(saveFiles(initialFiles()), undefined);
  const state = { open: true, full: true, path: "/a/b", follow: false, expanded: ["/a/b/c", "/a/b/c/d"], columnRoot: "/a", view: "columns" };
  const saved = saveFiles(state);
  assert.deepEqual(restoreFiles(JSON.parse(JSON.stringify(saved))), state);
  assert.ok(sameSaved(saved, saveFiles({ ...state })));
  assert.ok(!sameSaved(saved, saveFiles({ ...state, expanded: [] })));
});

test("restoreFiles drops malformed fields and old open/full-only data", async () => {
  const { restoreFiles } = await import("../src/files.ts");
  assert.equal(restoreFiles(undefined), undefined);
  assert.deepEqual(restoreFiles({ open: true, full: false }), { open: true, full: false, path: undefined, follow: true, expanded: [], columnRoot: undefined, view: undefined });
  assert.deepEqual(restoreFiles({ open: true, full: false, path: "/a", expanded: ["/a/x", "/other", 5] }).expanded, ["/a/x"]);
  assert.equal(restoreFiles({ open: true, path: "rel" }).path, undefined);
});
