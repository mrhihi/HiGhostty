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
  previewKind,
  ratioFromPointer,
  sameStamp,
  scrollAfterUpdate,
  splitBox,
  togglePreviewSide,
} from "../src/preview.ts";

const box = { x: 10, y: 20, width: 1000, height: 600 };

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
  assert.equal(clampRatio(0), 0.15);
  assert.equal(clampRatio(2), 0.85);
  assert.equal(clampRatio(NaN), 0.45);
  assert.equal(clampRatio(0.5), 0.5);
});

test("splitBox without preview leaves terminals alone", () => {
  assert.deepEqual(splitBox(box, undefined), { terminals: box });
});

test("splitBox right puts the preview on the right edge", () => {
  const { terminals, preview } = splitBox(box, openPreview("/a.md", "right", 0.5));
  assert.equal(terminals.x, 10);
  assert.equal(terminals.width + 6 + preview.width, 1000);
  assert.equal(preview.x, terminals.x + terminals.width + 6);
  assert.equal(preview.height, 600);
  assert.equal(terminals.height, 600);
});

test("splitBox bottom puts the preview under the terminals", () => {
  const { terminals, preview } = splitBox(box, openPreview("/a.md", "bottom", 0.5));
  assert.equal(terminals.height + 6 + preview.height, 600);
  assert.equal(preview.y, terminals.y + terminals.height + 6);
  assert.equal(preview.width, 1000);
});

test("splitBox drops the preview when the window is too small", () => {
  const small = { x: 0, y: 0, width: 300, height: 200 };
  assert.deepEqual(splitBox(small, openPreview("/a.md", "right")), { terminals: small });
  assert.deepEqual(splitBox(small, openPreview("/a.md", "bottom")), { terminals: small });
});

test("a new preview opens below the terminals by default", () => {
  assert.deepEqual(openPreview("/a.md"), { path: "/a.md", side: "bottom", ratio: 0.45 });
});

test("togglePreviewSide flips and keeps the rest", () => {
  const next = togglePreviewSide(openPreview("/a.md", "right", 0.3));
  assert.deepEqual(next, { path: "/a.md", side: "bottom", ratio: 0.3 });
  assert.equal(togglePreviewSide(next).side, "right");
});

test("ratioFromPointer maps the divider position back to a ratio", () => {
  const ratio = ratioFromPointer(box, "right", 10 + 497 + 3, 6);
  assert.ok(Math.abs(ratio - 0.5) < 0.01);
  assert.equal(ratioFromPointer(box, "right", 5000), 0.15);
  assert.equal(ratioFromPointer(box, "bottom", -100), 0.85);
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
