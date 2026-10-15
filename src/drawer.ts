export type Panel = "workspace" | "favorites" | "snippets" | "settings";
export type Detail =
  // Favorite groups: "group" lists the favorites inside one group.
  | { kind: "group"; groupId: string }
  | { kind: "edit-tab"; tabId: string; focus?: "name" }
  | { kind: "edit-group"; groupId?: string }
  // Without favoriteId the editor creates a favorite, optionally inside groupId.
  | { kind: "edit-favorite"; favoriteId?: string; groupId?: string; tabId?: string }
  // Without snippetId the editor creates a snippet, optionally preset to a scope/content.
  | { kind: "edit-snippet"; snippetId?: string; scope?: string; text?: string }
  // Without code the editor creates a new language.
  | { kind: "edit-locale"; code?: string };
export type DrawerState = { panel: Panel | null; lastPanel: Panel; detailStack: Detail[] };

export function togglePanel(state: DrawerState, panel: Panel): DrawerState {
  if (state.panel === panel) return { ...state, panel: null, detailStack: [] };
  return { ...state, panel, lastPanel: panel, detailStack: [] };
}
export function openPanel(state: DrawerState, panel: Panel): DrawerState {
  return { ...state, panel, lastPanel: panel };
}
export function closeAll(state: DrawerState): DrawerState {
  return { ...state, panel: null, detailStack: [] };
}
export function pushDetail(state: DrawerState, detail: Detail): DrawerState {
  return { ...state, detailStack: [...state.detailStack, detail] };
}
export function popDetail(state: DrawerState): DrawerState {
  return { ...state, detailStack: state.detailStack.slice(0, -1) };
}
export function replaceDetail(state: DrawerState, detail: Detail): DrawerState {
  return { ...state, detailStack: [...state.detailStack.slice(0, -1), detail] };
}
export function onGroupRemoved(state: DrawerState, groupId: string): DrawerState {
  return {
    ...state,
    detailStack: state.detailStack.filter(
      (detail) => !((detail.kind === "group" || detail.kind === "edit-group") && detail.groupId === groupId),
    ),
  };
}
