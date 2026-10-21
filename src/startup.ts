import { shellQuote } from "./control.ts";

// Launch arguments: `--tab <favorite name or id>` and `--dir <directory>`, both repeatable.
export type StartupArgs = { tabs: string[]; dirs: string[] };

export function parseStartupArgs(argv: string[]): StartupArgs {
  const result: StartupArgs = { tabs: [], dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    if (key !== "--tab" && key !== "--dir") continue;
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (!value) continue;
    (key === "--tab" ? result.tabs : result.dirs).push(value);
  }
  return result;
}

// Id first, then exact name, then case-insensitive name.
export function findFavoriteByQuery<T extends { id: string; name?: string }>(items: T[], query: string): T | undefined {
  const lower = query.toLowerCase();
  return items.find((item) => item.id === query)
    ?? items.find((item) => item.name === query)
    ?? items.find((item) => item.name?.toLowerCase() === lower);
}

// The `--tab` argument that opens this favorite: by name, or by id when another favorite would match first.
export function tabArgument<T extends { id: string; name?: string }>(items: T[], item: T): string {
  const byName = item.name && findFavoriteByQuery(items, item.name)?.id === item.id;
  return `--tab ${shellQuote(byName ? item.name! : item.id)}`;
}
