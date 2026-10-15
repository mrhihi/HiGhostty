// A member's launch spec for an independent work session (docs/project-collaboration-v2-plan.md §4.3).
// Pure. Derived from the command a terminal was started with, minus whatever ties it to the person's own
// conversation (resume / continue / session ids): a work session must begin fresh, never re-enter the main chat.
import { agentKindOf, parseAgentCommand, type ProgramResolver, type ProjectAgentKind } from "./project-control.ts";
import type { LaunchSpec } from "./project-types.ts";

export type LaunchFailure =
  | "not-agent"    // not one of the supported agents
  | "env-prefix"   // VAR=value before the program: the environment would be lost, so ask for explicit setup
  | "wrapper"      // an alias or wrapper stands for the agent; its real arguments are unknown
  | "unparseable" // quotes or escapes we will not guess at
  | "offline";     // no terminal to read the command from (decided by the caller)

export type LaunchResult = { ok: true; spec: LaunchSpec; dropped: string[] } | { ok: false; reason: LaunchFailure };

// Splits like a shell for the plain cases and refuses the rest, so an argument is never silently altered.
export function splitArgs(text: string): string[] | undefined {
  const out: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = undefined;
      // A shell would expand these inside double quotes; copying them literally would change what the argument means.
      else if (quote === '"' && (c === "$" || c === "`")) return undefined;
      else if (c === "\\" && quote === '"' && i + 1 < text.length && /["\\]/.test(text[i + 1])) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started || word) out.push(word); word = ""; started = false; }
    else if (/[;&|<>`$()\\*?{}#]/.test(c) || (c === "~" && !word && !started)) return undefined;
    else word += c;
  }
  if (quote) return undefined;
  if (started || word) out.push(word);
  return out;
}

// Flags that name an earlier conversation. `value` flags take an id as the next word when it is not itself a flag.
const SESSION_FLAGS: Record<ProjectAgentKind, { bare: string[]; value: string[] }> = {
  claude: { bare: ["-c", "--continue", "--fork-session"], value: ["-r", "--resume", "--session-id", "--from-pr"] },
  codex: { bare: [], value: [] },
  copilot: { bare: ["--continue"], value: ["--resume"] },
  gemini: { bare: [], value: ["-r", "--resume"] },
};
const SUBCOMMANDS: Partial<Record<ProjectAgentKind, string[]>> = { codex: ["resume", "fork"] };

export function launchSpecFromCommand(command: string | undefined, cwd: string, resolve?: ProgramResolver): LaunchResult {
  const kind = agentKindOf(command, resolve);
  if (!kind) return { ok: false, reason: "not-agent" };
  const parsed = parseAgentCommand(command, resolve)!;
  if (parsed.prefix) return { ok: false, reason: "env-prefix" };
  // Only the agent's own name counts as the program; an alias is the user's private wrapper.
  const base = parsed.program.split("/").pop() ?? "";
  if (base !== kind && !(kind === "copilot" && /^gh copilot$/.test(parsed.program.replace(/^.*\//, "")))) return { ok: false, reason: "wrapper" };
  const words = splitArgs(parsed.args);
  if (!words) return { ok: false, reason: "unparseable" };
  const flags = SESSION_FLAGS[kind];
  const dropped: string[] = [];
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const name = word.split("=")[0];
    if (i === 0 && SUBCOMMANDS[kind]?.includes(word)) {
      // `codex resume <id>`: everything up to the next flag belongs to the old conversation.
      dropped.push(word);
      while (i + 1 < words.length && !words[i + 1].startsWith("-")) dropped.push(words[++i]);
    } else if (flags.bare.includes(name)) dropped.push(word);
    else if (flags.value.includes(name)) {
      dropped.push(word);
      if (!word.includes("=") && i + 1 < words.length && !words[i + 1].startsWith("-")) dropped.push(words[++i]);
    } else args.push(word);
  }
  return { ok: true, spec: { kind, cwd: { kind: "absolute", path: cwd }, args, tmux: true }, dropped };
}
