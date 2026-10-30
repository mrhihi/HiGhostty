import test from "node:test";
import assert from "node:assert/strict";
import {
  clampFontSize,
  codeLanguage,
  isBinaryKind,
  clampWidth,
  measureFor,
  parseWidthInput,
  stepFontSize,
  clampRatio,
  linkTarget,
  localImagePath,
  relativeToDir,
  resolveInDir,
  openPreview,
  addPreviewFile,
  importPreviewGroups,
  previewPath,
  previewKind,
  ratioFromPointer,
  clampPreviewRatio,
  previewFits,
  sameStamp,
  scrollAfterUpdate,
} from "../src/preview.ts";


test("previewKind recognises playable video", () => {
  for (const f of ["a.mp4", "a.MOV", "a.m4v", "a.webm"]) assert.equal(previewKind("/x/" + f), "video");
  assert.equal(previewKind("/x/a.mkv"), "text");
});

test("previewKind picks markdown, image, else text", () => {
  assert.equal(previewKind("/a/PLAN.md"), "markdown");
  assert.equal(previewKind("/a/x.MARKDOWN"), "markdown");
  assert.equal(previewKind("/a/shot.PNG"), "image");
  assert.equal(previewKind("/a/main.rs"), "code");
  assert.equal(previewKind("/a/.md"), "text");
  assert.equal(previewKind("/a/notes.txt"), "text");
  assert.equal(previewKind("/a/Makefile"), "code");
});

test("previewKind maps draw.io files, but .drawio.svg/.png stay images", () => {
  assert.equal(previewKind("/a/flow.drawio"), "diagram");
  assert.equal(previewKind("/a/FLOW.DIO"), "diagram");
  assert.equal(previewKind("/a/flow.drawio.svg"), "image");
  assert.equal(previewKind("/a/flow.drawio.png"), "image");
  assert.equal(isBinaryKind("diagram"), false);
});

test("previewKind maps office and pdf files, codeLanguage maps languages", () => {
  assert.equal(previewKind("/a/x.PDF"), "pdf");
  assert.equal(previewKind("/a/x.xlsx"), "sheet");
  assert.equal(previewKind("/a/x.docx"), "word");
  assert.equal(previewKind("/a/x.pptx"), "slides");
  assert.equal(previewKind("/a/x.doc"), "text");
  assert.equal(codeLanguage("/a/x.tsx"), "typescript");
  assert.equal(codeLanguage("/a/Dockerfile"), "dockerfile");
  assert.equal(codeLanguage("/a/x.txt"), undefined);
  assert.equal(isBinaryKind("pdf"), true);
  assert.equal(isBinaryKind("code"), false);
});

test("clampRatio keeps the pane usable", () => {
  assert.equal(clampRatio(0), 0.2);
  assert.equal(clampRatio(2), 0.8);
  assert.equal(clampRatio(NaN), 0.5);
  assert.equal(clampRatio(0.5), 0.5);
});

test("clampPreviewRatio leaves both halves at least 240px", () => {
  assert.equal(clampPreviewRatio(0.5, 1000), 0.5);
  assert.equal(clampPreviewRatio(0.2, 600), 0.4);
  assert.equal(clampPreviewRatio(0.8, 600), 0.6);
  assert.equal(clampPreviewRatio(0.3, 0), 0.3);
});

test("previewFits needs a wide enough overlay", () => {
  assert.equal(previewFits(559), false);
  assert.equal(previewFits(560), true);
});

test("a new preview holds one tab", () => {
  const opened = openPreview("/a.md");
  assert.equal(previewPath(opened), "/a.md");
  assert.equal(opened.tabs.groups.length, 1);
});

test("ratioFromPointer maps the divider position back to a ratio", () => {
  const ratio = ratioFromPointer(100, 1000, 100 + 500);
  assert.ok(Math.abs(ratio - 0.5) < 0.01);
  assert.equal(ratioFromPointer(100, 1000, 5000), 0.24);
  assert.equal(ratioFromPointer(100, 1000, -100), 0.76);
});

test("scrollAfterUpdate follows the bottom, otherwise keeps the offset", () => {
  assert.equal(scrollAfterUpdate({ top: 400, height: 1000, client: 600 }, 1500, 600), 900);
  assert.equal(scrollAfterUpdate({ top: 100, height: 1000, client: 600 }, 1500, 600), 100);
  assert.equal(scrollAfterUpdate({ top: 100, height: 1000, client: 600 }, 300, 600), 0);
});

test("sameStamp compares mtime and size", () => {
  assert.ok(sameStamp({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 }));
  assert.ok(!sameStamp({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 3 }));
  assert.ok(!sameStamp(undefined, { mtimeMs: 1, size: 2 }));
});

test("linkTarget routes web, markdown and ignores the rest", () => {
  assert.deepEqual(linkTarget("https://x.dev/a", "/p/a.md"), { kind: "web", url: "https://x.dev/a" });
  assert.deepEqual(linkTarget("other.md", "/p/a.md"), { kind: "file", path: "/p/other.md" });
  assert.deepEqual(linkTarget("../b/c.md#top", "/p/q/a.md"), { kind: "file", path: "/p/b/c.md" });
  assert.deepEqual(linkTarget("/abs/x.md", "/p/a.md"), { kind: "file", path: "/abs/x.md" });
  assert.deepEqual(linkTarget("%E4%B8%AD.md", "/p/a.md"), { kind: "file", path: "/p/中.md" });
  assert.deepEqual(linkTarget("#section", "/p/a.md"), { kind: "none" });
  assert.deepEqual(linkTarget("file:///etc/passwd", "/p/a.md"), { kind: "none" });
  assert.deepEqual(linkTarget("javascript:alert(1)", "/p/a.md"), { kind: "none" });
  assert.deepEqual(linkTarget("script.sh", "/p/a.md"), { kind: "none" });
});

test("font size is clamped, stepped and defaults to 16", () => {
  assert.equal(clampFontSize(NaN), 16);
  assert.equal(clampFontSize(2), 11);
  assert.equal(clampFontSize(99), 32);
  assert.equal(clampFontSize(15.6), 16);
  assert.equal(stepFontSize(16, 1), 17);
  assert.equal(stepFontSize(11, -1), 11);
  assert.equal(stepFontSize(32, 1), 32);
});

test("column width is independent of text size, clamped, and parsed from typed input", () => {
  assert.equal(measureFor(0), "100%");
  assert.equal(measureFor(NaN), "100%");
  assert.equal(measureFor(70), "70%");
  assert.equal(clampWidth(5), 30);
  assert.equal(clampWidth(500), 100);
  assert.equal(parseWidthInput("75%", 100), 75);
  assert.equal(parseWidthInput(" 20 ", 100), 30);
  assert.equal(parseWidthInput("abc", 80), 80);
});

test("favorite default preview is stored relative to the tab folder", () => {
  assert.equal(relativeToDir("/work/app", "/work/app/docs/PLAN.md"), "docs/PLAN.md");
  assert.equal(relativeToDir("/work/app/", "/work/app/PLAN.md"), "PLAN.md");
  assert.equal(relativeToDir("/", "/PLAN.md"), "PLAN.md");
  assert.equal(relativeToDir("/work/app", "/work/app"), undefined);
  assert.equal(relativeToDir("/work/app", "/work/application/PLAN.md"), undefined);
  assert.equal(relativeToDir("/work/app", "/work/other/PLAN.md"), undefined);
  assert.equal(relativeToDir("/work/app", "/work/app/../x.md"), undefined);
});

test("favorite default preview resolves inside the new tab folder only", () => {
  assert.equal(resolveInDir("/work/app", "docs/PLAN.md"), "/work/app/docs/PLAN.md");
  assert.equal(resolveInDir("/work/app/", "PLAN.md"), "/work/app/PLAN.md");
  assert.equal(resolveInDir("/", "PLAN.md"), "/PLAN.md");
  assert.equal(resolveInDir("/work/app", ""), undefined);
  assert.equal(resolveInDir("/work/app", "/etc/hosts"), undefined);
  assert.equal(resolveInDir("/work/app", "../secret.md"), undefined);
  assert.equal(resolveInDir("/work/app", "a/../../secret.md"), undefined);
});

test("isMermaidLang / mermaidTheme", async () => {
  const { isMermaidLang, mermaidTheme } = await import("../src/preview.ts");
  assert.equal(isMermaidLang("language-mermaid"), true);
  assert.equal(isMermaidLang("hljs language-mermaid"), true);
  assert.equal(isMermaidLang("language-mermaidx"), false);
  assert.equal(isMermaidLang("language-ts"), false);
  assert.equal(mermaidTheme(true), "default");
  assert.equal(mermaidTheme(false), "dark");
});

test("previewKind renders .html/.htm as a page, not source code", () => {
  assert.equal(previewKind("/a/index.html"), "page");
  assert.equal(previewKind("/a/INDEX.HTM"), "page");
  assert.equal(isBinaryKind("page"), false);
});

test("localImagePath resolves relative images and skips other schemes", () => {
  assert.equal(localImagePath("../images/a.png", "/p/guides/x.md"), "/p/images/a.png");
  assert.equal(localImagePath("pic%20one.png?raw=1", "/p/x.md"), "/p/pic one.png");
  assert.equal(localImagePath("https://x.dev/a.png", "/p/x.md"), undefined);
  assert.equal(localImagePath("data:image/png;base64,AA", "/p/x.md"), undefined);
  assert.equal(localImagePath("note.md", "/p/x.md"), undefined);
});

test("addPreviewFile always adds a tab and only activates one that already shows the file", () => {
  const base = openPreview("/a.md");
  const two = addPreviewFile(base, "/b.md");
  assert.equal(two.tabs.groups.length, 2);
  assert.equal(previewPath(two), "/b.md");
  assert.equal(addPreviewFile(two, "/a.md").tabs.groups.length, 2); // same file: just activates
  assert.equal(previewPath(addPreviewFile(two, "/a.md")), "/a.md");
  assert.equal(previewPath(addPreviewFile(undefined, "/z.md")), "/z.md");
  assert.equal(addPreviewFile(two, "/c.md").tabs.groups.length, 3);
});

test("importPreviewGroups creates the pane or joins it, keeping merged groups", () => {
  const seeds = [{ paths: ["/a.md", "/b.md"], layout: "rows" }, { paths: ["/c.md"] }];
  const fresh = importPreviewGroups(undefined, seeds, 1);
  assert.equal(fresh.tabs.groups.length, 2);
  assert.equal(fresh.tabs.groups[0].layout, "rows");
  assert.equal(previewPath(fresh), "/c.md");
  const joined = importPreviewGroups(openPreview("/z.md"), seeds);
  assert.equal(joined.tabs.groups.length, 3);
});
