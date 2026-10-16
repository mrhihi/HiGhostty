import { t } from "./i18n.ts";
export type Leaf = { kind: "leaf"; id: string };
export type Branch = {
  kind: "branch";
  axis: "row" | "column";
  ratio: number;
  first: Node;
  second: Node;
};
export type Node = Leaf | Branch;
export type Rect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type GroupedItem = { id: string; groupId?: string };
export function orderGroupedItems<T extends GroupedItem>(items: T[], groupIds: string[]): T[] {
  const known = new Set(groupIds);
  return [
    ...items.filter((item) => !item.groupId || !known.has(item.groupId)),
    ...groupIds.flatMap((id) => items.filter((item) => item.groupId === id)),
  ];
}
// Tabs without a favorite keep their own order; a favorite's tab sits where its favorite
// sits in `favorites` (ungrouped favorites first, then each group), so opening or closing
// a terminal never moves a row.
export function orderTabsByFavorites<T extends { id: string; favoriteId?: string }>(tabs: T[], favorites: GroupedItem[], groupIds: string[]): T[] {
  const known = new Set(groupIds);
  const favoriteById = new Map(favorites.map((item) => [item.id, item]));
  const ungroupedFavorites = favorites.filter((item) => !(item.groupId && known.has(item.groupId)));
  const tabsOf = (item: GroupedItem) => tabs.filter((tab) => tab.favoriteId === item.id);
  return [
    ...tabs.filter((tab) => !tab.favoriteId || !favoriteById.has(tab.favoriteId)),
    ...ungroupedFavorites.flatMap(tabsOf),
    ...groupIds.flatMap((id) => favorites.filter((item) => item.groupId === id).flatMap(tabsOf)),
  ];
}
// Sub-tabs (one level only) sit right after their root tab; a sub-tab whose
// root is gone is treated as a root so it never disappears.
export function orderWithChildren<T extends { id: string; parentId?: string }>(tabs: T[]): T[] {
  const ids = new Set(tabs.map((tab) => tab.id));
  const isChild = (tab: T) => !!tab.parentId && ids.has(tab.parentId);
  return tabs.filter((tab) => !isChild(tab)).flatMap((root) => [root, ...tabs.filter((tab) => isChild(tab) && tab.parentId === root.id)]);
}
// When a root closes, its first sub-tab becomes the root and adopts the rest,
// so the tree never grows a second level. Returns the new root, if any.
export function promoteChildren<T extends { id: string; parentId?: string }>(tabs: T[], rootId: string): T | undefined {
  const [head, ...rest] = tabs.filter((tab) => tab.parentId === rootId);
  if (!head) return undefined;
  delete head.parentId;
  for (const tab of rest) tab.parentId = head.id;
  return head;
}
export function moveGroupedItem<T extends GroupedItem>(items: T[], id: string, targetGroupId: string | null, beforeId?: string): T[] {
  const moving = items.find((item) => item.id === id);
  if (!moving) return items;
  const rest = items.filter((item) => item.id !== id);
  const moved = { ...moving } as T;
  if (targetGroupId) moved.groupId = targetGroupId;
  else delete moved.groupId;
  let index = beforeId ? rest.findIndex((item) => item.id === beforeId) : -1;
  if (index < 0) {
    const targetItems = rest.map((item, itemIndex) => ({ item, itemIndex })).filter(({ item }) => targetGroupId ? item.groupId === targetGroupId : !item.groupId);
    index = targetItems.length ? targetItems.at(-1)!.itemIndex + 1 : rest.length;
  }
  rest.splice(index, 0, moved);
  return rest;
}
export function dissolveGroup<T extends GroupedItem>(items: T[], groupId: string): T[] {
  return items.map((item) => {
    if (item.groupId !== groupId) return item;
    const dissolved = { ...item } as T;
    delete dissolved.groupId;
    return dissolved;
  });
}
export function recentFavoriteInstance<T extends { id: string; favoriteId?: string }>(items: T[], favoriteId: string, recentId?: string): T | undefined {
  const matches = items.filter((item) => item.favoriteId === favoriteId);
  return matches.find((item) => item.id === recentId) || matches.at(-1);
}
export function moveItemBefore<T extends { id: string }>(items: T[], id: string, beforeId: string): T[] {
  const from = items.findIndex((item) => item.id === id);
  const to = items.findIndex((item) => item.id === beforeId);
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [moving] = next.splice(from, 1);
  next.splice(next.findIndex((item) => item.id === beforeId), 0, moving);
  return next;
}
export function leaves(node: Node): string[] {
  return node.kind === "leaf"
    ? [node.id]
    : [...leaves(node.first), ...leaves(node.second)];
}
export function split(
  node: Node,
  id: string,
  next: string,
  direction: number,
): Node {
  if (node.kind === "leaf") {
    if (node.id !== id) return node;
    const before = direction === 2 || direction === 3;
    return {
      kind: "branch",
      axis: direction === 0 || direction === 2 ? "row" : "column",
      ratio: 0.5,
      first: { kind: "leaf", id: before ? next : id },
      second: { kind: "leaf", id: before ? id : next },
    };
  }
  return {
    ...node,
    first: split(node.first, id, next, direction),
    second: split(node.second, id, next, direction),
  };
}
export function remove(node: Node, id: string): Node | undefined {
  if (node.kind === "leaf") return node.id === id ? undefined : node;
  const first = remove(node.first, id),
    second = remove(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}
export function equalize(node: Node): void {
  if (node.kind === "branch") {
    node.ratio = 0.5;
    equalize(node.first);
    equalize(node.second);
  }
}
export function rectangles(
  node: Node,
  x: number,
  y: number,
  width: number,
  height: number,
  gap = 6,
): Rect[] {
  if (node.kind === "leaf")
    return [
      {
        id: node.id,
        x,
        y,
        width: Math.max(0, width),
        height: Math.max(0, height),
      },
    ];
  if (node.axis === "row") {
    const span = Math.max(0, width - gap),
      first = span * node.ratio;
    return [
      ...rectangles(node.first, x, y, first, height, gap),
      ...rectangles(node.second, x + first + gap, y, span - first, height, gap),
    ];
  }
  const span = Math.max(0, height - gap),
    first = span * node.ratio;
  return [
    ...rectangles(node.first, x, y, width, first, gap),
    ...rectangles(node.second, x, y + first + gap, width, span - first, gap),
  ];
}
export function resizeSplit(
  node: Node,
  id: string,
  direction: number,
  amount: number,
): boolean {
  if (node.kind === "leaf") return false;
  const inFirst = leaves(node.first).includes(id),
    inSecond = leaves(node.second).includes(id);
  if (!inFirst && !inSecond) return false;
  if (resizeSplit(inFirst ? node.first : node.second, id, direction, amount))
    return true;
  const axis = direction === 0 || direction === 1 ? "column" : "row";
  if (node.axis !== axis) return false;
  const sign = direction === 0 || direction === 2 ? -1 : 1;
  node.ratio = Math.max(0.1, Math.min(0.9, node.ratio + sign * amount));
  return true;
}
export function neighbor(
  rects: Rect[],
  id: string,
  direction: number,
): string | undefined {
  const index = rects.findIndex((r) => r.id === id);
  if (index < 0) return;
  if (direction === 0 || direction === 1)
    return rects[
      (index + (direction === 0 ? -1 : 1) + rects.length) % rects.length
    ]?.id;
  const current = rects[index],
    cx = current.x + current.width / 2,
    cy = current.y + current.height / 2;
  const ranked = rects
    .filter((r) => r.id !== id)
    .map((r) => {
      const dx = r.x + r.width / 2 - cx,
        dy = r.y + r.height / 2 - cy;
      const forward =
        direction === 2
          ? -dy
          : direction === 3
            ? -dx
            : direction === 4
              ? dy
              : dx;
      const cross =
        direction === 2 || direction === 4 ? Math.abs(dx) : Math.abs(dy);
      return { id: r.id, score: forward > 0 ? forward + cross * 3 : Infinity };
    })
    .sort((a, b) => a.score - b.score);
  return ranked[0]?.score !== Infinity ? ranked[0]?.id : undefined;
}
export type FavoriteFolder = { id: string; kind: "folder"; name: string; color: string };
export type TabFavoriteItem<T> = { id: string; kind: "tab"; name: string; tab: T; groupId?: string };
type LegacyGroupFavorite<T> = { id: string; kind: "group"; name?: string; group?: { name?: string; color?: string }; tabs?: T[] };
export type StoredFavorite<T> = FavoriteFolder | TabFavoriteItem<T> | LegacyGroupFavorite<T>;
// Favorites are stored as one list of folders and tab favorites. Older
// versions stored "group favorites" (a snapshot of several tabs); each of
// those becomes a folder holding one tab favorite per saved tab.
export function migrateFavorites<T extends { paths: string[]; title?: string }>(
  items: StoredFavorite<T>[],
  newId: () => string,
): { folders: FavoriteFolder[]; favorites: TabFavoriteItem<T>[]; migrated: boolean } {
  const folders: FavoriteFolder[] = [], favorites: TabFavoriteItem<T>[] = [];
  let migrated = false;
  for (const item of items) {
    if (item.kind === "folder") folders.push(item);
    else if (item.kind === "tab") favorites.push(item);
    else if (item.kind === "group") {
      migrated = true;
      const name = item.name || item.group?.name || t("common.defaultGroup");
      folders.push({ id: item.id, kind: "folder", name, color: item.group?.color || "#77dfc0" });
      for (const saved of item.tabs || []) {
        const tab = { ...saved } as T & { groupId?: string; favoriteId?: string };
        delete tab.groupId; delete tab.favoriteId;
        const label = tab.title || tab.paths[0]?.split("/").filter(Boolean).at(-1) || "/";
        favorites.push({ id: newId(), kind: "tab", name: label, tab, groupId: item.id });
      }
    }
  }
  const known = new Set(folders.map((folder) => folder.id));
  for (const favorite of favorites) if (favorite.groupId && !known.has(favorite.groupId)) { delete favorite.groupId; migrated = true; }
  return { folders, favorites, migrated };
}
// A tab linked to a favorite shows the favorite's name; otherwise its own title,
// then the directory name.
export function displayName(favoriteName: string | undefined, title: string | undefined, fallback: string): string {
  return favoriteName || title || fallback;
}
// When a favorite goes away, its tabs keep the name they were showing.
export function unlinkedTitle(favoriteName: string | undefined, title: string | undefined): string | undefined {
  return favoriteName || title;
}
