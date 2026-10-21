import test from "node:test";
import assert from "node:assert/strict";
import {
  categoriesOf,
  cleanText,
  filterTodos,
  formatSend,
  MAX_TODO_CHARS,
  normalizeCategory,
  todoProblem,
  UNCATEGORIZED,
} from "../src/todo.ts";

const make = (id, text, category = "") => ({ id, text, category, createdAt: 0 });

test("todoProblem rejects blank, too long and NUL text", () => {
  assert.equal(todoProblem(""), "empty");
  assert.equal(todoProblem(" \n\t "), "empty");
  assert.equal(todoProblem("a\0b"), "nul");
  assert.equal(todoProblem("x".repeat(MAX_TODO_CHARS)), undefined);
  assert.equal(todoProblem("x".repeat(MAX_TODO_CHARS + 1)), "tooLong");
});

test("todoProblem accepts multi-line text", () => {
  assert.equal(todoProblem("first line\n  second line"), undefined);
});

test("cleanText keeps leading indentation and drops trailing whitespace", () => {
  assert.equal(cleanText("  indented\r\nnext\n\n  "), "  indented\nnext");
});

test("normalizeCategory collapses spaces and caps the length", () => {
  assert.equal(normalizeCategory("  bug   fix  "), "bug fix");
  assert.equal(normalizeCategory("a".repeat(60)).length, 40);
  assert.equal(normalizeCategory("   "), "");
});

test("categoriesOf lists unique non-empty categories sorted", () => {
  const items = [make("1", "a", "web"), make("2", "b", ""), make("3", "c", "api"), make("4", "d", "web")];
  assert.deepEqual(categoriesOf(items), ["api", "web"]);
});

test("filterTodos shows everything for null and only matches for a category", () => {
  const items = [make("1", "a", "web"), make("2", "b", ""), make("3", "c", "api")];
  assert.deepEqual(filterTodos(items, null).map((item) => item.id), ["1", "2", "3"]);
  assert.deepEqual(filterTodos(items, "api").map((item) => item.id), ["3"]);
  assert.deepEqual(filterTodos(items, UNCATEGORIZED).map((item) => item.id), ["2"]);
});

test("formatSend pastes a single item as-is", () => {
  assert.equal(formatSend([make("1", "  run the tests  ")]), "run the tests");
});

test("formatSend joins several items as a list with blank lines between them", () => {
  const items = [make("1", "fix login"), make("2", "line one\nline two")];
  assert.equal(formatSend(items), "- fix login\n\n- line one\n  line two");
});

test("formatSend never ends with a newline, so nothing is submitted", () => {
  const text = formatSend([make("1", "a\n"), make("2", "b\n")]);
  assert.ok(!/[\r\n]$/.test(text));
  assert.equal(formatSend([]), "");
});
