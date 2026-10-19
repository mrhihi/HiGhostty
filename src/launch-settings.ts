import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { AI_TOOLS, DEFAULT_TOOLS, ICON_NONE, applyModels, builtinModels, normalizeTools, validIconText, parseModelList, validApp, validModel, type LaunchTools } from "./launch";

// The menus read this cache synchronously (a native menu must not wait on I/O); it is refreshed
// on start, on window focus (another window may have edited it) and after every edit here.
let tools: LaunchTools = structuredClone(DEFAULT_TOOLS);
export const launchTools = () => tools;
export async function loadLaunchTools() {
  tools = normalizeTools((await invoke<unknown>("load_launch_tools").catch(() => null)) ?? undefined);
  applyModels(tools.models);
}
const persist = () => invoke("save_launch_tools", { tools });

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const field = (placeholder: string, value: string, mono = false) => {
  const input = el("input", mono ? "mono" : undefined); input.placeholder = placeholder; input.value = value; input.setAttribute("aria-label", placeholder);
  return input;
};
const uid = () => Math.random().toString(36).slice(2, 10);

// Settings block: global launch presets and "open folder with" apps. Rebuilt on locale change by the caller.
export function createLaunchToolsSection(notify: (error: unknown) => void): HTMLElement {
  const section = el("div", "launch-tools-section");
  const save = () => { persist().catch(notify); };
  const render = () => {
    section.replaceChildren();
    let card = el("div", "settings-card"); section.append(card);
    card.append(el("h4", undefined, t("launch.settings.presets")), el("p", "help", t("launch.settings.presetsHelp")));
    tools.presets.forEach((preset, index) => {
      const row = el("div", "launch-tool-row");
      const name = field(t("launch.settings.name"), preset.name);
      const tool = el("select"); tool.setAttribute("aria-label", t("app.launchTool"));
      for (const item of AI_TOOLS) { const option = el("option", undefined, item.label); option.value = item.id; tool.append(option); }
      tool.value = preset.tool;
      // Model: pick from the tool's list like the tab editor; "other" reveals a free-text name.
      const modelSelect = el("select"); modelSelect.setAttribute("aria-label", t("app.launchModel"));
      const modelOther = field(t("app.launchModelName"), "", true);
      const fillModels = () => {
        const models = AI_TOOLS.find((item) => item.id === preset.tool)?.models ?? [];
        modelSelect.replaceChildren();
        const add = (value: string, text: string) => { const option = el("option", undefined, text); option.value = value; modelSelect.append(option); };
        add("", t("app.launchModelDefault"));
        for (const m of models) add(m, m);
        add("__other__", t("app.launchModelOther"));
        const custom = !!preset.model && !models.includes(preset.model);
        modelSelect.value = custom ? "__other__" : preset.model;
        modelOther.hidden = !custom;
        modelOther.value = custom ? preset.model : "";
      };
      fillModels();
      const extra = field(t("app.launchExtraPlaceholder"), preset.extra, true);
      name.onchange = () => { preset.name = name.value.trim(); save(); };
      tool.onchange = () => { preset.tool = tool.value; preset.model = ""; fillModels(); save(); };
      modelSelect.onchange = () => {
        if (modelSelect.value === "__other__") { modelOther.hidden = false; modelOther.focus(); return; }
        modelOther.hidden = true; preset.model = modelSelect.value; save();
      };
      modelOther.onchange = () => { const value = modelOther.value.trim(); if (value && !validModel(value)) { modelOther.value = preset.model; return; } preset.model = value; save(); };
      extra.onchange = () => { preset.extra = extra.value.trim(); save(); };
      const remove = el("button", "ghost-btn", t("launch.settings.remove")); remove.type = "button";
      remove.onclick = () => { tools.presets.splice(index, 1); save(); render(); };
      row.append(name, tool, modelSelect, modelOther, extra, remove);
      card.append(row);
    });
    const addPreset = el("button", "ghost-btn", t("launch.settings.addPreset")); addPreset.type = "button";
    addPreset.onclick = () => { tools.presets.push({ id: uid(), name: "", tool: AI_TOOLS[0].id, model: "", extra: "" }); save(); render(); };
    card.append(addPreset);

    card = el("div", "settings-card"); section.append(card);
    card.append(el("h4", undefined, t("launch.settings.models")), el("p", "help", t("launch.settings.modelsHelp")));
    for (const item of AI_TOOLS) {
      const row = el("div", "launch-tool-row");
      const input = field(builtinModels(item.id).join(", "), tools.models[item.id]?.join(", ") ?? "", true);
      input.setAttribute("aria-label", `${item.label} ${t("app.launchModel")}`);
      input.onchange = () => {
        const names = parseModelList(input.value);
        if (names.length) tools.models[item.id] = names; else delete tools.models[item.id];
        applyModels(tools.models); save(); render();
      };
      const label = el("span", "launch-model-label", item.label);
      // Tab icon: the tool's own mark, another tool's mark, none, or custom text (emoji).
      const iconSelect = el("select"); iconSelect.setAttribute("aria-label", `${item.label} ${t("launch.settings.icon")}`);
      const iconOther = field(t("launch.settings.iconText"), "");
      const addIcon = (value: string, text: string) => { const option = el("option", undefined, text); option.value = value; iconSelect.append(option); };
      addIcon("", t("launch.settings.iconDefault"));
      for (const other of AI_TOOLS) if (other.id !== item.id) addIcon(other.id, other.label);
      addIcon(ICON_NONE, t("launch.settings.iconNone"));
      addIcon("__other__", t("launch.settings.iconCustom"));
      const current = tools.icons[item.id] ?? "";
      const customIcon = !!current && current !== ICON_NONE && !AI_TOOLS.some((other) => other.id === current);
      iconSelect.value = customIcon ? "__other__" : current;
      iconOther.hidden = !customIcon; iconOther.value = customIcon ? current : "";
      const setIcon = (value: string) => { if (value) tools.icons[item.id] = value; else delete tools.icons[item.id]; save(); };
      iconSelect.onchange = () => {
        if (iconSelect.value === "__other__") { iconOther.hidden = false; iconOther.focus(); return; }
        iconOther.hidden = true; setIcon(iconSelect.value);
      };
      iconOther.onchange = () => { const value = iconOther.value.trim(); if (value && !validIconText(value)) { iconOther.value = tools.icons[item.id] ?? ""; return; } setIcon(value); };
      const reset = el("button", "ghost-btn", t("launch.settings.resetModels")); reset.type = "button";
      reset.onclick = () => { delete tools.models[item.id]; applyModels(tools.models); save(); render(); };
      row.append(label, iconSelect, iconOther, input, reset);
      card.append(row);
    }

    card = el("div", "settings-card"); section.append(card);
    card.append(el("h4", undefined, t("launch.settings.openers")), el("p", "help", t("launch.settings.openersHelp")));
    tools.openers.forEach((opener, index) => {
      const row = el("div", "launch-tool-row");
      const name = field(t("launch.settings.name"), opener.name);
      const app = field(t("launch.settings.app"), opener.app);
      name.onchange = () => { opener.name = name.value.trim() || opener.app; save(); };
      app.onchange = () => { const value = app.value.trim(); if (!validApp(value)) { app.value = opener.app; return; } opener.app = value; save(); };
      const remove = el("button", "ghost-btn", t("launch.settings.remove")); remove.type = "button";
      remove.onclick = () => { tools.openers.splice(index, 1); save(); render(); };
      row.append(name, app, remove);
      card.append(row);
    });
    const addOpener = el("button", "ghost-btn", t("launch.settings.addOpener")); addOpener.type = "button";
    addOpener.onclick = () => { tools.openers.push({ id: uid(), name: "", app: "Visual Studio Code" }); save(); render(); };
    card.append(addOpener);
  };
  render();
  (section as HTMLElement & { rerender?: () => void }).rerender = render;
  return section;
}
