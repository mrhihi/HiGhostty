// Launch command presets for the AI coding tools. The tab/favorite still stores one plain
// command string; this module only builds it from (tool, model, extra arguments) and reads it back.
export type AiTool = { id: string; label: string; program: string; modelFlag: string; models: string[] };
export const AI_TOOLS: AiTool[] = [
  { id: "claude", label: "Claude Code", program: "claude", modelFlag: "--model", models: ["opus", "sonnet", "haiku"] },
  { id: "codex", label: "Codex CLI", program: "codex", modelFlag: "--model", models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] },
  { id: "copilot", label: "GitHub Copilot CLI", program: "copilot", modelFlag: "--model", models: ["claude-sonnet-4.5", "claude-sonnet-4", "gpt-5"] },
  { id: "gemini", label: "Gemini CLI", program: "gemini", modelFlag: "--model", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
];
export type Launch = { tool: AiTool; model: string; extra: string };

// Model names go straight into a shell line, so only plain identifiers are accepted.
export const validModel = (model: string) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model);

export function composeLaunch(tool: AiTool, model: string, extra: string): string {
  const parts = [tool.program];
  if (model && validModel(model)) parts.push(tool.modelFlag, model);
  if (extra.trim()) parts.push(extra.trim());
  return parts.join(" ");
}

// Reads a stored command back into the picker; anything else (other programs, env prefixes,
// a path instead of a bare name) stays a custom command.
export function parseLaunch(command: string | undefined): Launch | undefined {
  const text = (command ?? "").trim();
  const tool = AI_TOOLS.find((item) => text === item.program || text.startsWith(item.program + " "));
  if (!tool) return undefined;
  const rest = text.slice(tool.program.length).trim();
  const match = rest.match(/^(?:--model[=\s]\s*|-m\s+)(\S+)\s*(.*)$/s);
  if (match && validModel(match[1])) return { tool, model: match[1], extra: match[2].trim() };
  return { tool, model: "", extra: rest };
}

// A custom command as two fields: the program (with any leading VAR=value words) and its arguments.
export function splitCommand(command: string | undefined): { program: string; args: string } {
  const match = (command ?? "").trim().match(/^((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\S+)\s*(.*)$/s);
  return match ? { program: match[1], args: match[2].trim() } : { program: "", args: "" };
}
export const joinCommand = (program: string, args: string) => [program.trim(), args.trim()].filter(Boolean).join(" ");

// Global quick-launch presets (right-click a tab → open a new tab in its folder with one of these)
// and "open folder with" apps. Both live in launch-tools.json; bad entries are dropped, not fatal.
export type LaunchPreset = { id: string; name: string; tool: string; model: string; extra: string };
export type Opener = { id: string; name: string; app: string };
// models: per-tool model lists that replace the built-in ones (tool id → names); a tool without an entry keeps its built-in list.
export type LaunchTools = { presets: LaunchPreset[]; openers: Opener[]; models: Record<string, string[]>; icons: Record<string, string> };

export const DEFAULT_TOOLS: LaunchTools = {
  models: {},
  icons: {},
  presets: [
    { id: "claude", name: "Claude Code", tool: "claude", model: "", extra: "" },
    { id: "codex", name: "Codex CLI", tool: "codex", model: "", extra: "" },
    { id: "gemini", name: "Gemini CLI", tool: "gemini", model: "", extra: "" },
  ],
  openers: [{ id: "vscode", name: "Visual Studio Code", app: "Visual Studio Code" }],
};

export const presetCommand = (preset: LaunchPreset): string | undefined => {
  const tool = AI_TOOLS.find((item) => item.id === preset.tool);
  return tool ? composeLaunch(tool, preset.model, preset.extra) : undefined;
};
export const presetLabel = (preset: LaunchPreset) => preset.name || AI_TOOLS.find((item) => item.id === preset.tool)?.label || preset.tool;

// The app name goes to `open -a` as one argument; control characters and a leading "-" are refused.
export const validApp = (app: string) => !!app.trim() && !/[\u0000-\u001f\u007f]/.test(app) && !app.trim().startsWith("-");

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
function unique<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}
export function normalizePresets(raw: unknown): LaunchPreset[] {
  if (!Array.isArray(raw)) return [];
  const items: LaunchPreset[] = [];
  raw.forEach((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const tool = text(item.tool), model = text(item.model);
    if (!AI_TOOLS.some((candidate) => candidate.id === tool)) return;
    items.push({ id: text(item.id) || `preset-${index}`, name: text(item.name), tool, model: validModel(model) ? model : "", extra: text(item.extra) });
  });
  return unique(items);
}
export function normalizeOpeners(raw: unknown): Opener[] {
  if (!Array.isArray(raw)) return [];
  const items: Opener[] = [];
  raw.forEach((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const app = text(item.app);
    if (!validApp(app)) return;
    items.push({ id: text(item.id) || `opener-${index}`, name: text(item.name) || app, app });
  });
  return unique(items);
}
const BUILTIN_MODELS: Record<string, string[]> = Object.fromEntries(AI_TOOLS.map((tool) => [tool.id, [...tool.models]]));
export const builtinModels = (toolId: string) => BUILTIN_MODELS[toolId] ?? [];
// Accepts commas, spaces or newlines between names; invalid names and duplicates are dropped.
export const parseModelList = (value: string) => [...new Set(value.split(/[\s,]+/).filter(validModel))];
export function normalizeModels(raw: unknown): Record<string, string[]> {
  const models: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return models;
  for (const tool of AI_TOOLS) {
    const list = (raw as Record<string, unknown>)[tool.id];
    const names = Array.isArray(list) ? parseModelList(list.filter((item) => typeof item === "string").join(" ")) : [];
    if (names.length) models[tool.id] = names;
  }
  return models;
}
// Tab icon per tool (tool id → value): "" / missing = the tool's own mark, "none" = no icon, another
// tool's id = that tool's mark, anything else = a short custom text such as an emoji.
export const ICON_NONE = "none";
export const validIconText = (value: string) => !!value && [...value].length <= 4 && !/[\u0000-\u001f\u007f]/.test(value);
export function normalizeIcons(raw: unknown): Record<string, string> {
  const icons: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return icons;
  for (const tool of AI_TOOLS) {
    const value = text((raw as Record<string, unknown>)[tool.id]);
    if (value && value !== tool.id && validIconText(value)) icons[tool.id] = value;
  }
  return icons;
}
// What a tab shows for a tool: a built-in mark id, custom text, or nothing.
export function resolveIcon(toolId: string, icons: Record<string, string>): { mark?: string; text?: string } {
  const value = icons[toolId] ?? "";
  if (value === ICON_NONE) return {};
  if (!value) return { mark: toolId };
  if (AI_TOOLS.some((tool) => tool.id === value)) return { mark: value };
  return { text: value };
}
// Makes the pickers (tab editor, favorites, settings) use the configured lists.
export function applyModels(models: Record<string, string[]>) {
  for (const tool of AI_TOOLS) tool.models = models[tool.id] ?? builtinModels(tool.id);
}
// A missing file (undefined) means "never configured" and gets the defaults; an existing file is honored as is.
export function normalizeTools(raw: unknown): LaunchTools {
  if (raw === undefined || raw === null || typeof raw !== "object") return structuredClone(DEFAULT_TOOLS);
  const doc = raw as Record<string, unknown>;
  return { presets: normalizePresets(doc.presets), openers: normalizeOpeners(doc.openers), models: normalizeModels(doc.models), icons: normalizeIcons(doc.icons) };
}
