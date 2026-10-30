import test from "node:test";
import assert from "node:assert/strict";
import { gitSummary, isDirty, sameGit, stripHeight, STRIP_HEIGHT } from "../src/git.ts";

const labels = { detached: "detached", noUpstream: "no upstream" };
const clean = { branch: "main", detached: false, upstream: true, changed: 0, ahead: 0, behind: 0 };

test("strip takes space only inside a repo", () => {
  assert.equal(stripHeight(clean), STRIP_HEIGHT);
  assert.equal(stripHeight(null), 0);
  assert.equal(stripHeight(undefined), 0);
});

test("summary always shows the state; ahead/behind only when non-zero", () => {
  assert.equal(gitSummary(clean, labels), "⎇ main  ✓");
  assert.equal(gitSummary({ ...clean, ahead: 2 }, labels), "⎇ main  ✓  ↑2");
  assert.equal(gitSummary({ ...clean, behind: 1 }, labels), "⎇ main  ✓  ↓1");
  assert.equal(gitSummary({ ...clean, changed: 3, ahead: 2, behind: 1 }, labels), "⎇ main  ● 3  ↑2 ↓1");
  assert.equal(gitSummary({ ...clean, upstream: false }, labels), "⎇ main  ✓  no upstream");
  assert.equal(gitSummary({ ...clean, branch: "", detached: true }, labels), "⎇ detached  ✓");
});

test("isDirty follows the change count", () => {
  assert.equal(isDirty(clean), false);
  assert.equal(isDirty({ ...clean, changed: 1 }), true);
});

test("sameGit compares every field and handles missing values", () => {
  assert.equal(sameGit(clean, { ...clean }), true);
  assert.equal(sameGit(clean, { ...clean, changed: 1 }), false);
  assert.equal(sameGit(clean, { ...clean, ahead: 1 }), false);
  assert.equal(sameGit(clean, { ...clean, upstream: false }), false);
  assert.equal(sameGit(null, null), true);
  assert.equal(sameGit(null, clean), false);
  assert.equal(sameGit(undefined, null), false);
});

test("tabGitText: compact branch and change count", async () => {
  const { tabGitText } = await import("../src/git.ts");
  const base = { branch: "main", detached: false, upstream: true, changed: 0, ahead: 2, behind: 0 };
  assert.equal(tabGitText(base, "detached"), "main ✓");
  assert.equal(tabGitText({ ...base, changed: 3 }, "detached"), "main ●3");
  assert.equal(tabGitText({ ...base, detached: true }, "detached"), "detached ✓");
});

test("worktree tooltip lists where it lives and what it came from", async () => {
  const { gitTip } = await import("../src/git.ts");
  const l = { ...labels, worktree: "Worktree", worktreeMain: "Main repo" };
  const wt = { root: "/a/wt", main: "/a/main" };
  assert.equal(gitTip(clean, l, wt), "⎇ main  ✓\nWorktree: /a/wt\nMain repo: /a/main");
  assert.equal(gitTip(clean, l), "");
  assert.equal(gitTip({ ...clean, ahead: 2 }, l), "⎇ main  ✓  ↑2");
  assert.equal(gitTip({ ...clean, upstream: false }, l), "⎇ main  ✓  no upstream");
  const { sameWorktree } = await import("../src/git.ts");
  assert.equal(sameWorktree(null, undefined), true);
  assert.equal(sameWorktree(wt, { ...wt }), true);
  assert.equal(sameWorktree(wt, null), false);
});
