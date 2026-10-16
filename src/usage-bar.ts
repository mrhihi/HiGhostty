import { invoke } from "@tauri-apps/api/core";
import { applyI18n, onLocaleChange } from "./i18n-runtime";
import { t } from "./i18n";
import { displayPct, effective, errorText, warningText, formatDuration, formatPct, levelOf, parseUsage, resetText, type Mode, type ProductUsage, type UsageWindow } from "./usage";

// 底部右側的用量指示（Claude Code / Codex 的 5 小時與每週用量），點擊浮出細節。
// 細節浮層和 ⌘⇧P 面板一樣靠 overlay-cutout 蓋在終端機 NSView 之上，規則見 docs/usage.md。
export type UsageBarHost = {
  native: (request: Record<string, unknown>) => Promise<unknown>;
  focusTerminal: () => void;
  notify: (error: unknown) => void;
  // 開啟前關掉共用 overlay-cutout 的其他浮層。
  closeOthers: () => void;
};

// 資料只會慢慢變，又要避開 Anthropic 的限流：輪詢間隔與 Rust 端快取同為 3 分鐘，開很多視窗也各自低頻。
const POLL_MS = 180_000;
const TICK_MS = 60_000;
const CLAUDE_PREF = "usage-claude";
const MODE_PREF = "usage-mode";

function readPref(): boolean {
  try { return localStorage.getItem(CLAUDE_PREF) !== "off"; } catch { return true; }
}
function readMode(): Mode {
  try { return localStorage.getItem(MODE_PREF) === "left" ? "left" : "used"; } catch { return "used"; }
}
function writeMode(mode: Mode) {
  try { localStorage.setItem(MODE_PREF, mode); } catch { /* 沒有儲存空間時只在本次生效 */ }
}
function writePref(on: boolean) {
  try { localStorage.setItem(CLAUDE_PREF, on ? "on" : "off"); } catch { /* 沒有儲存空間時只在本次生效 */ }
}

export function initUsageBar(host: UsageBarHost) {
  let claudeOn = readPref();
  let mode = readMode();
  let claude: ProductUsage | null = null;
  let codex: ProductUsage | null = null;
  let fetchedAt = 0;
  let observer: ResizeObserver | undefined;

  const button = document.createElement("button");
  button.id = "usage-btn";
  button.type = "button";
  button.className = "usage-btn";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");

  const pop = document.createElement("div");
  pop.id = "usage-pop";
  pop.setAttribute("role", "dialog");
  pop.tabIndex = -1;
  pop.hidden = true;

  const isOpen = () => !pop.hidden;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function num(win: UsageWindow | null, label: string, now: number): HTMLElement {
    const span = el("span", "usage-num");
    const eff = effective(win, now);
    span.append(el("span", "usage-label", label), document.createTextNode(` ${eff ? formatPct(displayPct(eff.pct, mode)) : "—"}`));
    span.dataset.level = eff ? levelOf(eff.pct) : "none";
    return span;
  }

  function group(name: string, usage: ProductUsage | null, now: number): HTMLElement {
    const box = el("span", "usage-group");
    box.append(el("span", "usage-name", name));
    if (!usage) box.append(el("span", "usage-num", "…"));
    else {
      box.append(num(usage.fiveHour, t("usage.fiveShort"), now), el("span", "usage-sep", "·"), num(usage.week, t("usage.weekShort"), now));
    }
    return box;
  }

  // 內容沒變就不動 DOM，避免無謂的重畫。
  let buttonSig = "";
  function renderButton() {
    const now = Date.now();
    const title = `${t("usage.barTitle")} (${t(mode === "left" ? "usage.modeLeft" : "usage.modeUsed")})`;
    const next: HTMLElement[] = [group(t("usage.codex"), codex, now)];
    if (claudeOn) next.unshift(group(t("usage.claude"), claude, now), el("span", "usage-div"));
    const sig = `${title}|${next.map((n) => `${n.textContent}${[...n.querySelectorAll<HTMLElement>("[data-level]")].map((x) => x.dataset.level).join("")}`).join("|")}`;
    if (sig === buttonSig) return;
    buttonSig = sig;
    button.replaceChildren(...next);
    button.title = title;
    button.setAttribute("aria-label", title);
  }

  function row(label: string, win: UsageWindow | null, now: number): HTMLElement {
    const box = el("div", "usage-row");
    const eff = effective(win, now);
    const head = el("div", "usage-row-head");
    const value = el("strong", "usage-pct", eff ? formatPct(displayPct(eff.pct, mode)) : "—");
    value.dataset.level = eff ? levelOf(eff.pct) : "none";
    head.append(el("span", "usage-row-label", label), value);
    const track = el("div", "usage-track");
    const fill = el("div", "usage-fill");
    fill.style.width = `${eff ? displayPct(eff.pct, mode) : 0}%`;
    fill.dataset.level = eff ? levelOf(eff.pct) : "none";
    track.append(fill);
    box.append(head, track);
    const reset = resetText(win, now);
    if (reset) box.append(el("div", "usage-reset", reset));
    return box;
  }

  function section(name: string, usage: ProductUsage | null, now: number): HTMLElement {
    const box = el("section", "usage-section");
    const head = el("div", "usage-section-head");
    head.append(el("strong", "", name));
    if (usage?.plan) head.append(el("span", "usage-plan", t("usage.plan", { plan: usage.plan })));
    box.append(head);
    if (!usage) box.append(el("div", "usage-reset", t("usage.loading")));
    else if (usage.error) box.append(el("div", "usage-error", errorText(usage.error)));
    else {
      box.append(row(t("usage.fiveHour"), usage.fiveHour, now), row(t("usage.week"), usage.week, now));
      if (usage.warning) box.append(el("div", "usage-reset", warningText(usage.warning)));
    }
    return box;
  }

  function renderPop() {
    if (!isOpen()) return;
    const now = Date.now();
    const bar = el("div", "usage-pop-bar");
    const refresh = el("button", "ghost-btn", t("usage.refresh"));
    refresh.type = "button";
    refresh.onclick = () => refreshNow(true).catch(host.notify);
    const closeBtn = el("button", "ghost-btn", t("usage.close"));
    closeBtn.type = "button";
    closeBtn.onclick = () => close();
    const seg = el("div", "usage-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", t("usage.modeLabel"));
    for (const value of ["used", "left"] as Mode[]) {
      const option = el("button", "usage-seg-btn", t(value === "left" ? "usage.modeLeft" : "usage.modeUsed"));
      option.type = "button";
      option.setAttribute("aria-pressed", String(mode === value));
      option.onclick = () => { mode = value; writeMode(mode); renderButton(); renderPop(); };
      seg.append(option);
    }
    bar.append(el("strong", "", t("usage.title")), el("span", "usage-spacer"), seg, refresh, closeBtn);

    const sections = el("div", "usage-sections");
    if (claudeOn) sections.append(section(t("usage.claude"), claude, now));
    else {
      const off = el("section", "usage-section");
      off.append(el("div", "usage-section-head"), el("div", "usage-reset", `${t("usage.claude")}: ${t("usage.claudeOff")}`));
      sections.append(off);
    }
    sections.append(section(t("usage.codex"), codex, now));

    const foot = el("div", "usage-foot");
    const label = el("label", "usage-toggle");
    const box = el("input");
    box.type = "checkbox";
    box.checked = claudeOn;
    box.onchange = () => {
      claudeOn = box.checked;
      writePref(claudeOn);
      renderButton();
      renderPop();
      if (claudeOn) refreshNow(true).catch(host.notify);
    };
    label.append(box, document.createTextNode(` ${t("usage.enableClaude")}`));
    foot.append(label);
    if (fetchedAt) foot.append(el("div", "usage-reset", t("usage.updated", { time: formatDuration(now - fetchedAt) })));
    pop.replaceChildren(bar, sections, foot);
    pop.setAttribute("aria-label", t("usage.title"));
  }

  async function refreshNow(force = false) {
    const [codexRaw, claudeRaw] = await Promise.all([
      invoke("usage_codex").catch(() => ({ error: "no-data" })),
      claudeOn ? invoke("usage_claude", { force }).catch(() => ({ error: "network" })) : Promise.resolve(null),
    ]);
    codex = parseUsage(codexRaw);
    claude = claudeRaw ? parseUsage(claudeRaw) : null;
    fetchedAt = Date.now();
    renderButton();
    renderPop();
  }

  // 浮層開著時要讓終端機 NSView 讓出這塊（docs/usage.md）。
  function reportCutout(restoreFocus = false) {
    const box = pop.getBoundingClientRect();
    const open = isOpen() && box.height > 0;
    host.native({ op: "overlay-cutout", x: box.x - 8, y: box.y - 8, width: open ? box.width + 16 : 0, height: open ? box.height + 16 : 0, viewportWidth: window.innerWidth, restoreFocus }).catch(host.notify);
  }
  async function open() {
    if (isOpen()) return;
    host.closeOthers();
    pop.hidden = false;
    button.setAttribute("aria-expanded", "true");
    renderPop();
    observer = new ResizeObserver(() => reportCutout());
    observer.observe(pop);
    reportCutout();
    // 開浮層不主動重抓：資料夠新就直接用快取。
    if (Date.now() - fetchedAt > POLL_MS) refreshNow().catch(host.notify);
    await host.native({ op: "focus-web" });
    if (!isOpen()) { host.focusTerminal(); return; }
    pop.focus();
  }
  function close(refocus = true) {
    if (!isOpen()) return;
    observer?.disconnect();
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    reportCutout(refocus);
    if (refocus) host.focusTerminal();
  }

  button.onclick = () => (isOpen() ? close() : open().catch(host.notify));
  document.addEventListener("keydown", (event) => { if (isOpen() && event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } }, true);
  document.addEventListener("mousedown", (event) => { if (isOpen() && event.target instanceof Node && !pop.contains(event.target) && !button.contains(event.target)) close(); }, true);
  window.addEventListener("blur", () => { if (isOpen()) close(false); });
  onLocaleChange(() => { applyI18n(pop); renderButton(); renderPop(); });

  renderButton();
  refreshNow().catch(() => {});
  setInterval(() => { if (document.visibilityState === "visible") refreshNow().catch(() => {}); }, POLL_MS);
  // 倒數文字每分鐘更新一次，不必重新抓資料；浮層裡正在操作控制項時不重畫，免得搶走焦點。
  setInterval(() => {
    renderButton();
    if (isOpen() && !(document.activeElement && document.activeElement !== pop && pop.contains(document.activeElement))) renderPop();
  }, TICK_MS);

  return { button, element: pop, open, close, isOpen };
}
export type UsageBar = ReturnType<typeof initUsageBar>;
