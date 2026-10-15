import test from "node:test";
import { useLocale } from "./i18n-helper.mjs";
import assert from "node:assert/strict";
import {
  applicable,
  expand,
  filterSnippets,
  fuzzy,
  groupByScope,
  rememberRecent,
  scopeChoices,
  scopeLabel,
} from "../src/snippets.ts";
useLocale();

const make = (id, name, scope, extra = {}) => ({ id, name, text: extra.text || name, scope, createdAt: 0, ...extra });

test("applicable keeps global and ancestor snippets, nearest first", () => {
  const items = [
    make("g", "global", "global"),
    make("p", "proj", "/home/u/proj"),
    make("s", "src", "/home/u/proj/src"),
    make("o", "other", "/home/u/other"),
    make("pre", "prefix", "/home/u/pro"),
  ];
  assert.deepEqual(applicable(items, "/home/u/proj/src").map((i) => i.id), ["s", "p", "g"]);
  assert.deepEqual(applicable(items, undefined).map((i) => i.id), ["g"]);
});

test("recent use orders snippets within the same scope", () => {
  const items = [make("a", "alpha", "global"), make("b", "beta", "global")];
  assert.deepEqual(applicable(items, "/x", ["b"]).map((i) => i.id), ["b", "a"]);
});

test("fuzzy matches subsequences and rejects misses", () => {
  assert.deepEqual(fuzzy("gs", "git status")?.hits, [0, 4]);
  assert.equal(fuzzy("zz", "git status"), undefined);
  assert.ok(fuzzy("git", "git status").score > fuzzy("gst", "git status").score);
});

test("filter searches name, keywords and first line, best first", () => {
  const items = [
    make("1", "deploy", "global", { keywords: "release ship" }),
    make("2", "status", "global", { text: "git status" }),
    make("3", "other", "global", { text: "ls\nrm" }),
  ];
  assert.deepEqual(filterSnippets(items, "ship").map((m) => m.snippet.id), ["1"]);
  assert.deepEqual(filterSnippets(items, "git").map((m) => m.snippet.id), ["2"]);
  assert.deepEqual(filterSnippets(items, "rm"), []);
  assert.equal(filterSnippets(items, "").length, 3);
});

test("expand substitutes variables and appends Enter when run", () => {
  const snippet = make("1", "n", "global", { text: "cd ${cwd} # ${dir} ${home}\n", run: true });
  assert.equal(expand(snippet, "/a/b", "/h"), "cd /a/b # b /h\r");
  assert.equal(expand({ ...snippet, run: false }, "/a/b", "/h"), "cd /a/b # b /h\n");
});

test("scope helpers", () => {
  assert.equal(scopeLabel("global", "/h"), "全域");
  assert.equal(scopeLabel("/h/p", "/h"), "~/p");
  assert.deepEqual(scopeChoices("/a/b"), ["/a/b", "/a"]);
  assert.deepEqual(groupByScope([make("1", "b", "/z"), make("2", "a", "global")]).map((g) => g.scope), ["global", "/z"]);
});

test("recent list is deduplicated and capped", () => {
  assert.deepEqual(rememberRecent(["a", "b"], "b"), ["b", "a"]);
  assert.equal(rememberRecent(["a", "b", "c"], "d", 2).length, 2);
});
