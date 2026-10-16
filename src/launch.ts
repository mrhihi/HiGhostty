// Launch command presets for the AI coding tools. The tab/favorite still stores one plain
// command string; this module only builds it from (tool, model, extra arguments) and reads it back.
export type AiTool = { id: string; label: string; program: string; modelFlag: string; models: string[] };
export const AI_TOOLS: AiTool[] = [
  { id: "claude", label: "Claude Code", program: "claude", modelFlag: "--model", models: ["opus", "sonnet", "haiku"] },
  { id: "codex", label: "Codex CLI", program: "codex", modelFlag: "--model", models: ["gpt-5-codex", "gpt-5", "o3"] },
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
