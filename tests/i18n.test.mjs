import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTranslator, diffFromBuiltin, mergeLocales, missingKeys, paramsOf, parseLocaleFile, placeholderMismatch, resolveLocale, serializeLocale, validLocaleCode } from "../src/i18n.ts";
import { builtinCodes, loadBuiltin } from "./i18n-helper.mjs";

const en = { "a.title": "Title", "a.hello": "Hello {name}", "a.count.one": "{n} file", "a.count.other": "{n} files" };

test("locale codes are safe file names", () => {
  for (const ok of ["en", "zh-Hant", "pt-BR", "ja", "sr-Latn-RS"]) assert.ok(validLocaleCode(ok), ok);
  for (const bad of ["", "EN", "../x", "en/US", "en_US", "zh-Hant.json", "e", 5, null]) assert.ok(!validLocaleCode(bad), String(bad));
});

test("resolveLocale follows the system list and falls back to en", () => {
  const have = ["en", "zh-Hant"];
  assert.equal(resolveLocale("system", ["zh-TW"], have), "zh-Hant");
  assert.equal(resolveLocale("system", ["zh-Hant-TW"], have), "zh-Hant");
  assert.equal(resolveLocale("system", ["zh-HK", "en-US"], have), "zh-Hant");
  assert.equal(resolveLocale("system", ["ja-JP", "en-US"], have), "en");
  assert.equal(resolveLocale("system", ["zh-CN"], have), "en");
  assert.equal(resolveLocale("system", ["zh-CN"], [...have, "zh-Hans"]), "zh-Hans");
  assert.equal(resolveLocale("system", ["en-GB"], have), "en");
  assert.equal(resolveLocale("system", ["pt-BR"], [...have, "pt"]), "pt");
  assert.equal(resolveLocale("system", [], have), "en");
  assert.equal(resolveLocale("ja", ["zh-TW"], have), "en");
  assert.equal(resolveLocale("zh-Hant", ["en"], have), "zh-Hant");
});

test("parseLocaleFile validates and warns", () => {
  const ok = parseLocaleFile(JSON.stringify({ _meta: { locale: "ja", name: "日本語" }, messages: { "a.hello": "こんにちは {name}", "a.nope": "x" } }), en);
  assert.equal(ok.file.locale, "ja");
  assert.equal(ok.file.name, "日本語");
  assert.deepEqual(ok.warnings, ["unknown key: a.nope"]);
  const mismatch = parseLocaleFile(JSON.stringify({ _meta: { locale: "ja" }, messages: { "a.hello": "こんにちは" } }), en);
  assert.deepEqual(mismatch.warnings, ["placeholder mismatch: a.hello"]);
  assert.equal(mismatch.file.name, "ja");
  assert.ok(!parseLocaleFile("{bad", en).file);
  assert.ok(!parseLocaleFile(JSON.stringify({ _meta: { locale: "../x" }, messages: {} })).file);
  assert.ok(!parseLocaleFile(JSON.stringify({ _meta: { locale: "ja" }, messages: { a: 1 } })).file);
  assert.ok(!parseLocaleFile(JSON.stringify({ messages: {} })).file);
  assert.ok(!parseLocaleFile("[]").file);
  // plural variants of a known base key are not "unknown"
  assert.deepEqual(parseLocaleFile(JSON.stringify({ _meta: { locale: "ja" }, messages: { "a.count.other": "{n}個" } }), en).warnings, []);
});

test("translator interpolates, pluralizes and falls back", () => {
  const t = createTranslator({ "a.title": "標題", "a.hello": "你好 {name}" }, en, "zh-Hant");
  assert.equal(t("a.title"), "標題");
  assert.equal(t("a.hello", { name: "Paul" }), "你好 Paul");
  assert.equal(t("a.count", { n: 1 }), "1 file");
  assert.equal(t("a.count", { n: 3 }), "3 files");
  assert.equal(t("missing.key"), "missing.key");
  assert.equal(t("a.hello", {}), "你好 {name}");
  const only = createTranslator({}, en);
  assert.equal(only("a.title"), "Title");
});

test("merge, missing keys and diff", () => {
  assert.deepEqual(mergeLocales({ a: "1", b: "2" }, { b: "x" }), { a: "1", b: "x" });
  assert.deepEqual(mergeLocales(undefined, { b: "x" }), { b: "x" });
  assert.deepEqual(missingKeys({ "a.title": "T", "a.hello": " " }, en), ["a.hello", "a.count.one", "a.count.other"]);
  assert.deepEqual(placeholderMismatch({ "a.hello": "hi" }, en), ["a.hello"]);
  assert.deepEqual(diffFromBuiltin({ a: "1", b: "x", c: "  " }, { a: "1", b: "2" }), { b: "x" });
  assert.deepEqual(paramsOf("{b} {a} {b}"), ["a", "b"]);
  const text = serializeLocale({ locale: "ja", name: "日本語", messages: { a: "1" } });
  assert.equal(parseLocaleFile(text).file.messages.a, "1");
});

test("built-in locales stay consistent", () => {
  const codes = builtinCodes();
  assert.ok(codes.includes("en") && codes.includes("zh-Hant"));
  const base = loadBuiltin("en");
  assert.ok(Object.keys(base).length > 0);
  for (const code of codes) {
    const messages = loadBuiltin(code);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(base).sort(), `${code} keys differ from en`);
    for (const key of Object.keys(base)) {
      assert.equal(typeof messages[key], "string", `${code}:${key}`);
      assert.ok(messages[key].length > 0, `${code}:${key} is empty`);
    }
    assert.deepEqual(placeholderMismatch(messages, base), [], `${code} placeholders`);
  }
});

// 略過 exFAT 上 macOS 產生的 ._* AppleDouble 檔。
const walk = (dir) => readdirSync(dir).filter((f) => !f.startsWith(".")).flatMap((f) => { const p = `${dir}/${f}`; return statSync(p).isDirectory() ? (f === "locales" ? [] : walk(p)) : [p]; });
test("every key used in source exists in en.json", () => {
  const base = loadBuiltin("en");
  const known = (key) => key in base || /\.(zero|one|two|few|many|other)$/.test(key) === false && Object.keys(base).some((k) => k.startsWith(`${key}.`));
  const used = new Map();
  for (const file of walk(fileURLToPath(new URL("../src", import.meta.url))).filter((f) => /\.(ts|html)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bt\(\s*["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)["'`]/g)) used.set(m[1], file);
    for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"$]+)"/g)) used.set(m[1], file);
  }
  const html = ["index.html", "preview.html"].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.set(m[1], "html");
  for (const [key, file] of used) assert.ok(known(key), `${key} (${file}) missing from en`);
});
