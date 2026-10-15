import { applyI18n, onLocaleChange } from "./i18n-runtime";
import { t } from "./i18n";

// 待處理浮層：和 ⌘⇧P 片段面板一樣從工作區頂部落下，靠 overlay-cutout 蓋在終端機 NSView 之上。
// 開關／遮罩／焦點的規則見 docs/snippet-palette.md 與 docs/attention.md。
export type AttentionDropHost = {
  native: (request: Record<string, unknown>) => Promise<unknown>;
  focusTerminal: () => void;
  notify: (error: unknown) => void;
  render: () => void;
  clearAll: () => void;
  closeIcon: string;
};

export function initAttentionDrop(host: AttentionDropHost) {
  const drop = document.createElement("div");
  drop.id = "attention-drop";
  drop.setAttribute("role", "dialog");
  drop.setAttribute("aria-label", "Attention");
  drop.tabIndex = -1;
  drop.hidden = true;
  const bar = document.createElement("div");
  bar.className = "attention-bar";
  const title = document.createElement("strong");
  title.dataset.i18n = "attention.title";
  title.textContent = "Attention";
  const clearAll = document.createElement("button");
  clearAll.className = "ghost-btn";
  clearAll.dataset.i18n = "attention.clearAll";
  clearAll.textContent = "Clear all";
  clearAll.onclick = () => host.clearAll();
  const closeBtn = document.createElement("button");
  closeBtn.className = "icon-btn";
  closeBtn.setAttribute("data-i18n-title", "attention.closeTitle");
  closeBtn.setAttribute("data-i18n-aria-label", "attention.close");
  closeBtn.title = "Close (Esc)";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = host.closeIcon;
  closeBtn.onclick = () => close();
  const spacer = document.createElement("span");
  spacer.className = "attention-spacer";
  bar.append(title, spacer, clearAll, closeBtn);
  const list = document.createElement("div");
  list.id = "attention-list";
  const foot = document.createElement("div");
  foot.className = "palette-foot";
  foot.innerHTML = `<span><kbd>↑</kbd><kbd>↓</kbd> <i data-i18n="attention.hintSelect">Select</i></span><span><kbd>↵</kbd> <i data-i18n="attention.hintGo">Go</i></span><span><kbd>⌫</kbd> <i data-i18n="attention.hintDismiss">Dismiss</i></span><span><kbd>Esc</kbd> <i data-i18n="attention.hintClose">Close</i></span>`;
  drop.append(bar, list, foot);
  const labelRoot = () => { applyI18n(drop); drop.setAttribute("aria-label", t("attention.title")); };
  labelRoot();
  // 語言切換：靜態文字重套，開著時重畫卡片（卡片內容由 host.render 產生）。
  onLocaleChange(() => { labelRoot(); if (!drop.hidden) host.render(); });

  let observer: ResizeObserver | undefined;
  let selected = 0;
  const isOpen = () => !drop.hidden;
  const cards = () => [...list.querySelectorAll<HTMLElement>(".alert-card")];

  function select(index: number, scroll = true) {
    const items = cards();
    if (!items.length) { selected = 0; return; }
    selected = (index + items.length) % items.length;
    items.forEach((card, i) => card.classList.toggle("selected", i === selected));
    if (scroll) items[selected].scrollIntoView({ block: "nearest" });
  }
  // Cards are rebuilt on every state change; re-apply the highlight afterwards.
  // The clicked button is gone after a rebuild, so pull focus back or Esc/arrows go dead.
  const afterRender = () => {
    if (!isOpen()) return;
    foot.hidden = cards().length === 0;
    select(Math.min(selected, cards().length - 1), false);
    if (!drop.contains(document.activeElement)) drop.focus();
  };

  // Keep the native terminals from covering the panel (see docs/snippet-palette.md).
  function reportCutout(restoreFocus = false) {
    const box = drop.getBoundingClientRect();
    const open = isOpen() && box.height > 0;
    host.native({ op: "overlay-cutout", x: box.x - 8, y: box.y - 8, width: open ? box.width + 16 : 0, height: open ? box.height + 24 : 0, viewportWidth: window.innerWidth, restoreFocus }).catch(host.notify);
  }
  async function open() {
    if (isOpen()) return;
    drop.hidden = false;
    selected = 0;
    host.render();
    select(0, false);
    observer = new ResizeObserver(() => reportCutout());
    observer.observe(drop);
    reportCutout();
    await host.native({ op: "focus-web" });
    // Closed while focus-web was in flight: don't leave focus stuck in the WebView.
    if (!isOpen()) { host.focusTerminal(); return; }
    drop.focus();
  }
  function close(refocus = true) {
    if (!isOpen()) return;
    observer?.disconnect();
    drop.hidden = true;
    reportCutout(refocus);
    if (refocus) host.focusTerminal();
  }

  drop.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    // Let focused buttons keep their own Enter/Space behavior.
    if (event.target instanceof HTMLElement && event.target.closest("button")) return;
    const items = cards();
    if (event.key === "ArrowDown") { event.preventDefault(); select(selected + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); select(selected - 1); }
    else if (event.key === "Enter") { event.preventDefault(); items[selected]?.querySelector<HTMLButtonElement>("[data-act=go]")?.click(); }
    else if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); items[selected]?.querySelector<HTMLButtonElement>("[data-act=dismiss]")?.click(); }
  });
  // Focus can fall to <body> (e.g. after a card is dismissed); Esc must still close.
  document.addEventListener("keydown", (event) => { if (isOpen() && event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } }, true);
  document.addEventListener("mousedown", (event) => { if (isOpen() && event.target instanceof Node && !drop.contains(event.target) && !(event.target instanceof Element && event.target.closest("#bell-btn, #rail-attention"))) close(); }, true);
  window.addEventListener("blur", () => { if (isOpen()) close(false); });

  return { element: drop, list, open, close, isOpen, afterRender, toggle: () => (isOpen() ? close() : open().catch(host.notify)) };
}
export type AttentionDrop = ReturnType<typeof initAttentionDrop>;
