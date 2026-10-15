import { invoke } from "@tauri-apps/api/core";
import { diffFromBuiltin, missingKeys, paramsOf, parseLocaleFile, serializeLocale, t, validLocaleCode, type Messages } from "./i18n";
import { applyI18n, availableLocales, builtinMessages, effectiveMessages, enMessages, languageSetting, onLocaleChange, resolvedLocale, setLanguage, userLocale, userLocaleErrors } from "./i18n-runtime";
import { builtinNames } from "./locales";

export type LanguageDeps = {
  native: <T = Record<string, unknown>>(request: Record<string, unknown>) => Promise<T>;
  notify: (error: unknown) => void;
  openEditor: (code?: string) => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const withI18n = <T extends HTMLElement>(node: T, key: string) => { node.dataset.i18n = key; node.textContent = t(key); return node; };
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function pickPath(deps: LanguageDeps, op: "pick-file" | "save-file", name?: string): Promise<string | null> {
  const r = await deps.native<{ path: string | null }>({ op, name });
  return r.path;
}

// 匯入：先在前端完整驗證，通過才寫進資料目錄；內容正規化後再存（不信任原檔格式）。
async function importLocale(deps: LanguageDeps, status: HTMLElement) {
  const path = await pickPath(deps, "pick-file");
  if (!path) return;
  try {
    const text = await invoke<string>("locale_read_file", { path });
    const parsed = parseLocaleFile(text, enMessages());
    if (!parsed.file) { status.textContent = t("language.importFailed", { reason: parsed.errors.join("; ") }); return; }
    await invoke("locale_save", { code: parsed.file.locale, text: serializeLocale(parsed.file) });
    const warnings = parsed.warnings.length ? " " + t("language.warnings", { list: parsed.warnings.slice(0, 5).join(", ") + (parsed.warnings.length > 5 ? ", …" : "") }) : "";
    status.textContent = t("language.imported", { code: parsed.file.locale }) + warnings;
  } catch (error) { status.textContent = t("language.importFailed", { reason: reason(error) }); }
}

async function exportLocale(deps: LanguageDeps, code: string, status: HTMLElement) {
  const info = availableLocales().find((l) => l.code === code);
  const path = await pickPath(deps, "save-file", `${code}.json`);
  if (!path) return;
  try {
    await invoke("locale_write_file", { path, text: serializeLocale({ locale: code, name: info?.name ?? code, messages: effectiveMessages(code) }) });
    status.textContent = t("language.exported", { path });
  } catch (error) { deps.notify(error); }
}

// 設定面板的「語言」區塊。選單與錯誤訊息在語系或語系檔變動時重建。
export function createLanguageSection(deps: LanguageDeps): HTMLElement {
  const section = el("div", "language-section");
  const heading = withI18n(el("h4"), "language.title");
  const help = withI18n(el("p", "help"), "language.help");
  const select = el("select"); select.id = "ui-language"; select.setAttribute("aria-label", t("language.title"));
  const status = el("p", "help"); status.id = "language-status";
  const row = el("div", "button-row");
  const mk = (key: string, fn: () => unknown) => { const b = withI18n(el("button", "ghost-btn"), key); b.type = "button"; b.onclick = () => { Promise.resolve().then(fn).catch(deps.notify); }; return b; };
  const importBtn = mk("language.import", () => importLocale(deps, status));
  const editBtn = mk("language.edit", () => deps.openEditor(select.value === "system" ? resolvedLocale() : select.value));
  const newBtn = mk("language.new", () => deps.openEditor());
  const exportBtn = mk("language.export", () => exportLocale(deps, select.value === "system" ? resolvedLocale() : select.value, status));
  row.append(importBtn, editBtn, newBtn, exportBtn);
  section.append(heading, help, select, status, row);

  let building = false;
  const rebuild = () => {
    building = true;
    const infos = availableLocales();
    const resolved = infos.find((l) => l.code === resolvedLocale());
    select.replaceChildren(new Option(t("language.system", { name: resolved?.name ?? resolvedLocale() }), "system"));
    for (const info of infos) select.add(new Option(`${info.name} (${info.code})${info.custom && info.builtin ? " · " + t("language.customized") : ""}`, info.code));
    select.value = infos.some((l) => l.code === languageSetting()) || languageSetting() === "system" ? languageSetting() : "system";
    select.setAttribute("aria-label", t("language.title"));
    const broken = [...userLocaleErrors].map(([code, errors]) => t("language.brokenFile", { code, reason: errors.join("; ") }));
    if (broken.length) status.textContent = broken.join(" ");
    building = false;
  };
  select.onchange = () => { if (!building) setLanguage(select.value).catch(deps.notify); };
  onLocaleChange(rebuild);
  rebuild();
  return section;
}

// drawer 詳細頁的簡易編輯器：以英文的 key 為基準列出所有字串，可搜尋、只看未翻譯。
// 呼叫端（main.ts renderDetail）負責標題與返回；這裡只畫內容與底部按鈕。
export function renderLocaleEditor(host: HTMLElement, code: string | undefined, deps: { back: () => void; notify: (e: unknown) => void }): void {
  const base = enMessages();
  const isNew = !code;
  const builtin = code ? builtinMessages(code) : undefined;
  const edited: Messages = code ? { ...effectiveMessages(code) } : {};
  let codeValue = code ?? "";
  let nameValue = code ? (userLocale(code)?.name ?? builtinNames[code] ?? code) : "";
  let query = "";
  let onlyMissing = false;
  let limit = 60;

  const form = el("div", "language-editor");
  const field = (labelKey: string, input: HTMLElement) => { const f = el("label", "field"); f.append(withI18n(el("span", "caption"), labelKey), input); return f; };
  const codeInput = el("input", "mono"); codeInput.value = codeValue; codeInput.disabled = !isNew; codeInput.placeholder = t("language.editor.codePlaceholder"); codeInput.spellcheck = false; codeInput.autocapitalize = "off";
  const nameInput = el("input"); nameInput.value = nameValue; nameInput.placeholder = t("language.editor.namePlaceholder");
  const problem = el("p", "help error"); problem.hidden = true;
  const progress = el("p", "help");
  const search = el("input", "snippet-search"); search.type = "search"; search.placeholder = t("language.editor.search"); search.setAttribute("aria-label", t("language.editor.search"));
  const onlyLabel = el("label", "toggle"); const only = el("input"); only.type = "checkbox"; onlyLabel.append(only, document.createTextNode(t("language.editor.onlyMissing")));
  const list = el("div", "language-rows");
  const hint = withI18n(el("p", "help"), "language.editor.hint");
  form.append(field("language.editor.code", codeInput), field("language.editor.name", nameInput), problem, progress, search, onlyLabel, list, hint);
  host.append(form);

  const keys = Object.keys(base);
  const done = () => keys.length - missingKeys(edited, base).length;
  const updateProgress = () => { progress.textContent = t("language.editor.subtitle", { done: done(), total: keys.length }); };

  const render = () => {
    list.replaceChildren();
    const q = query.trim().toLowerCase();
    const matches = keys.filter((k) => (!onlyMissing || !edited[k]?.trim()) && (!q || k.toLowerCase().includes(q) || base[k].toLowerCase().includes(q) || (edited[k] ?? "").toLowerCase().includes(q)));
    if (!matches.length) { list.append(withI18n(el("p", "help"), "language.editor.empty")); return; }
    for (const key of matches.slice(0, limit)) {
      const row = el("div", "language-row");
      const keyLabel = el("code", "language-key", key);
      const original = el("div", "language-original", base[key]);
      const long = base[key].length > 40 || base[key].includes("\n");
      const input = long ? el("textarea") : el("input");
      (input as HTMLInputElement | HTMLTextAreaElement).value = edited[key] ?? "";
      if (input instanceof HTMLTextAreaElement) input.rows = Math.min(6, Math.ceil(base[key].length / 28));
      input.setAttribute("aria-label", key);
      const warn = el("div", "help error"); warn.hidden = true;
      const check = () => {
        const value = edited[key] ?? "";
        const bad = value.trim() !== "" && paramsOf(value).join() !== paramsOf(base[key]).join();
        warn.hidden = !bad;
        if (bad) warn.textContent = t("language.editor.placeholderWarn", { params: paramsOf(base[key]).map((p) => `{${p}}`).join(" ") || "—" });
      };
      input.addEventListener("input", () => { edited[key] = (input as HTMLInputElement).value; check(); updateProgress(); });
      check();
      row.append(keyLabel, original, input, warn);
      list.append(row);
    }
    if (matches.length > limit) {
      const more = el("button", "ghost-btn wide-button", t("language.editor.more", { left: matches.length - limit })); more.type = "button";
      more.onclick = () => { limit += 100; render(); };
      list.append(more);
    }
  };
  search.addEventListener("input", () => { query = search.value; limit = 60; render(); });
  only.addEventListener("change", () => { onlyMissing = only.checked; limit = 60; render(); });
  updateProgress();
  render();

  const footer = el("div", "sticky-actions");
  const cancel = el("button", "ghost-btn", t("language.editor.cancel")); cancel.type = "button"; cancel.onclick = deps.back;
  const save = el("button", "primary-btn", t("language.editor.save")); save.type = "button";
  save.onclick = async () => {
    problem.hidden = true;
    const target = (isNew ? codeInput.value.trim() : codeValue);
    if (!validLocaleCode(target)) { problem.textContent = t("language.editor.badCode"); problem.hidden = false; return; }
    if (isNew && availableLocales().some((l) => l.code === target)) { problem.textContent = t("language.editor.codeTaken"); problem.hidden = false; return; }
    const name = nameInput.value.trim() || builtinNames[target] || target;
    // 只存與內建不同的字串；內建語系名稱沒改就不寫 name 以外的東西。
    const messages = diffFromBuiltin(edited, builtinMessages(target));
    try {
      if (!Object.keys(messages).length && builtinMessages(target) && name === (builtinNames[target] ?? target)) await invoke("locale_delete", { code: target });
      else await invoke("locale_save", { code: target, text: serializeLocale({ locale: target, name, messages }) });
      deps.back();
    } catch (error) { deps.notify(error); }
  };
  footer.append(cancel, save);
  if (code && userLocale(code)) {
    const remove = el("button", "danger-btn wide-button", t(builtin ? "language.editor.restore" : "language.editor.delete")); remove.type = "button";
    let armed = false;
    remove.onclick = async () => {
      if (!armed) { armed = true; remove.textContent = t("language.editor.confirmAgain"); setTimeout(() => { armed = false; remove.textContent = t(builtin ? "language.editor.restore" : "language.editor.delete"); }, 3000); return; }
      try { await invoke("locale_delete", { code }); deps.back(); } catch (error) { deps.notify(error); }
    };
    host.append(remove);
  }
  host.append(footer);
  applyI18n(host);
}
