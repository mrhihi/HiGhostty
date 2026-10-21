import test from "node:test";
import assert from "node:assert/strict";
import { parseStartupArgs, findFavoriteByQuery, tabArgument } from "../src/startup.ts";

test("parses repeatable --tab and --dir in both forms", () => {
  assert.deepEqual(parseStartupArgs(["--tab", "api", "--dir=/tmp", "--tab=web", "--other", "--dir"]), { tabs: ["api", "web"], dirs: ["/tmp"] });
});

test("favorite lookup prefers id, then exact name, then case-insensitive name", () => {
  const items = [{ id: "a", name: "Web" }, { id: "web", name: "x" }];
  assert.equal(findFavoriteByQuery(items, "web")?.id, "web");
  assert.equal(findFavoriteByQuery(items, "Web")?.id, "a");
  assert.equal(findFavoriteByQuery([{ id: "a", name: "Web" }], "WEB")?.id, "a");
  assert.equal(findFavoriteByQuery(items, "nope"), undefined);
});

test("tab argument uses the name, quoted, unless another favorite would win", () => {
  const items = [{ id: "a", name: "My Web" }, { id: "b", name: "My Web" }, { id: "c", name: "api" }];
  assert.equal(tabArgument(items, items[0]), "--tab 'My Web'");
  assert.equal(tabArgument(items, items[1]), "--tab b");
  assert.equal(tabArgument(items, items[2]), "--tab api");
});
