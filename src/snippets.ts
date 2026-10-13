// Pure logic for the ⌘⇧P snippet palette; DOM lives in snippet-palette.ts.
export type Snippet = {
  id: string;
  name: string;
  text: string;
  // "global" or an absolute directory; applies to that directory and everything below it.
  scope: string;
  keywords?: string;
  // Append Enter after inserting.
  run?: boolean;
  createdAt: number;
};
export type SnippetsDocument = { revision: number; items: Snippet[] };
export type Match = { snippet: Snippet; score: number; nameHits: number[] };

export const GLOBAL = "global";

export function isGlobal(scope: string): boolean {
  return scope === GLOBAL;
}
function covers(scope: string, cwd: string): boolean {
  if (scope === "/") return cwd.startsWith("/");
  return cwd === scope || cwd.startsWith(scope + "/");
}
// Global snippets plus those bound to cwd or one of its parents; the nearest directory first.
export function applicable(items: Snippet[], cwd: string | undefined, recent: string[] = []): Snippet[] {
  const rank = (item: Snippet) => (isGlobal(item.scope) ? 0 : item.scope.length);
  const used = (item: Snippet) => {
    const index = recent.indexOf(item.id);
    return index < 0 ? Infinity : index;
  };
  return items
    .filter((item) => isGlobal(item.scope) || (!!cwd && covers(item.scope, cwd)))
    .sort((a, b) => rank(b) - rank(a) || used(a) - used(b) || a.name.localeCompare(b.name));
}
// Case-insensitive subsequence match; consecutive and word-start hits score higher.
export function fuzzy(query: string, target: string): { score: number; hits: number[] } | undefined {
  const q = query.toLowerCase(), t = target.toLowerCase();
  const hits: number[] = [];
  let score = 0, from = 0, previous = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return undefined;
    hits.push(at);
    score += 1 + (at === previous + 1 ? 3 : 0) + (at === 0 || /[\s_\-/.]/.test(t[at - 1]) ? 2 : 0);
    previous = at;
    from = at + 1;
  }
  return { score: score - hits[0] * 0.1 - t.length * 0.01, hits };
}
export function filterSnippets(items: Snippet[], query: string): Match[] {
  const q = query.trim();
  if (!q) return items.map((snippet) => ({ snippet, score: 0, nameHits: [] }));
  const matches: Match[] = [];
  for (const snippet of items) {
    const name = fuzzy(q, snippet.name);
    const others = [snippet.keywords || "", snippet.text.split("\n")[0]].map((value) => fuzzy(q, value));
    const best = Math.max(name ? name.score + 5 : -Infinity, ...others.map((match) => (match ? match.score : -Infinity)));
    if (best === -Infinity) continue;
    matches.push({ snippet, score: best, nameHits: name?.hits || [] });
  }
  // Stable sort keeps the scope/recency order for equal scores.
  return matches.sort((a, b) => b.score - a.score);
}
function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || "/";
}
export function expand(snippet: Snippet, cwd: string, home: string): string {
  const text = snippet.text
    .replaceAll("${cwd}", cwd)
    .replaceAll("${dir}", baseName(cwd))
    .replaceAll("${home}", home);
  return snippet.run ? text.replace(/\n+$/, "") + "\r" : text;
}
export function scopeLabel(scope: string, home: string): string {
  if (isGlobal(scope)) return "全域";
  if (scope === home) return "~";
  return scope.startsWith(home + "/") ? "~" + scope.slice(home.length) : scope;
}
// Directories the scope picker offers for cwd: cwd itself and each parent.
export function scopeChoices(cwd: string | undefined): string[] {
  if (!cwd) return [];
  const parts = cwd.split("/").filter(Boolean);
  const choices: string[] = [];
  for (let i = parts.length; i >= 1; i--) choices.push("/" + parts.slice(0, i).join("/"));
  return choices;
}
export function groupByScope(items: Snippet[]): { scope: string; items: Snippet[] }[] {
  const groups = new Map<string, Snippet[]>();
  for (const item of items) groups.set(item.scope, [...(groups.get(item.scope) || []), item]);
  return [...groups.entries()]
    .sort(([a], [b]) => (isGlobal(a) ? -1 : isGlobal(b) ? 1 : a.localeCompare(b)))
    .map(([scope, list]) => ({ scope, items: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}
export function rememberRecent(recent: string[], id: string, limit = 50): string[] {
  return [id, ...recent.filter((value) => value !== id)].slice(0, limit);
}
