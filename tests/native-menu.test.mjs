import test from "node:test";
import assert from "node:assert/strict";
import { createMenuPopup } from "../src/native-menu.ts";

// A fake menu that stays open until close() of the returned handle is called.
function harness() {
  const log = [];
  let open = 0, dismiss;
  const newMenu = async (options) => {
    assert.equal(open, 0, "no menu may be created while one is open");
    const id = options.id;
    log.push(`new ${id}`);
    return {
      popup: () => { open++; log.push(`popup ${id}`); return new Promise((resolve) => { dismiss = () => { open--; resolve(); }; }); },
      close: async () => { assert.equal(open, 0, "no menu may be closed while one is open"); log.push(`close ${id}`); },
    };
  };
  return { log, newMenu, dismiss: () => dismiss() };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("ignores popups while a menu is open", async () => {
  const h = harness();
  const popup = createMenuPopup(h.newMenu);
  const first = popup({ id: 1 });
  await tick();
  await popup({ id: 2 });
  h.dismiss();
  await first;
  assert.deepEqual(h.log, ["new 1", "popup 1"]);
});

test("releases the previous menu before creating the next one", async () => {
  const h = harness();
  const popup = createMenuPopup(h.newMenu);
  const first = popup({ id: 1 });
  await tick(); h.dismiss(); await first;
  const second = popup({ id: 2 });
  await tick(); h.dismiss(); await second;
  assert.deepEqual(h.log, ["new 1", "popup 1", "close 1", "new 2", "popup 2"]);
});

test("recovers after a failed popup", async () => {
  let calls = 0;
  const popup = createMenuPopup(async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return { popup: async () => {}, close: async () => {} };
  });
  await assert.rejects(popup({}), /boom/);
  await popup({});
  assert.equal(calls, 2);
});
