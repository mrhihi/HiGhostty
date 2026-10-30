// Git strip under each split pane. Pure helpers only; the status itself comes from
// `git_status` (src-tauri/src/git.rs) and the DOM lives in main.ts.
export type GitInfo = {
  branch: string;
  detached: boolean;
  upstream: boolean;
  changed: number;
  ahead: number;
  behind: number;
};
// Fetched separately from GitInfo (`git_worktree`): it is slower, so the badge shows first without it.
export type Worktree = { root: string; main: string };
export type GitLabels = { detached: string; noUpstream: string; worktree: string; worktreeMain: string };

export const STRIP_HEIGHT = 20;
// Pixels the strip takes from the bottom of a pane. Panes outside a repo keep the full height.
export const stripHeight = (info: GitInfo | null | undefined): number => (info ? STRIP_HEIGHT : 0);

// "⎇ main  ● 3  ↑2 ↓1": the change count (or ✓ when clean) is always shown; ahead/behind only
// when non-zero; a note when there is no upstream.
export function gitSummary(info: GitInfo, labels: GitLabels): string {
  const parts = [`⎇ ${info.detached ? labels.detached : info.branch}`];
  parts.push(info.changed ? `● ${info.changed}` : "✓");
  if (!info.upstream) parts.push(labels.noUpstream);
  else if (info.ahead || info.behind) parts.push([info.ahead && `↑${info.ahead}`, info.behind && `↓${info.behind}`].filter(Boolean).join(" "));
  return parts.join("  ");
}

// Tab row version: "main ●3" / "main ✓", no upstream or ahead/behind text.
export const tabGitText = (info: GitInfo, detached: string): string =>
  `${info.detached ? detached : info.branch} ${info.changed ? `●${info.changed}` : "✓"}`;

// Tooltip for the tab badge: the summary, plus where a linked worktree lives and what it was added from.
// Empty when it would only repeat the badge (no worktree, upstream set, nothing ahead or behind).
export function gitTip(info: GitInfo, labels: GitLabels, worktree?: Worktree | null): string {
  if (!worktree && info.upstream && !info.ahead && !info.behind) return "";
  const lines = [gitSummary(info, labels)];
  if (worktree) lines.push(`${labels.worktree}: ${worktree.root}`, `${labels.worktreeMain}: ${worktree.main}`);
  return lines.join("\n");
}

export const isDirty = (info: GitInfo): boolean => info.changed > 0;

export const sameWorktree = (a: Worktree | null | undefined, b: Worktree | null | undefined): boolean =>
  a?.root === b?.root && a?.main === b?.main;

export function sameGit(a: GitInfo | null | undefined, b: GitInfo | null | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.branch === b.branch &&
    a.detached === b.detached &&
    a.upstream === b.upstream &&
    a.changed === b.changed &&
    a.ahead === b.ahead &&
    a.behind === b.behind
  );
}
