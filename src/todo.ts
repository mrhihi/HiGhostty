// Pure logic for the ⌘⇧L todo drop; DOM lives in todo-drop.ts.
export type Todo = {
  id: string;
  // Multi-line text; pasted or typed with line breaks.
  text: string;
  // Free-form label; "" means uncategorized.
  category: string;
  createdAt: number;
};
export type TodosDocument = { revision: number; items: Todo[] };
export type TodoProblem = "empty" | "tooLong" | "nul";

export const MAX_TODO_CHARS = 20000;
export const MAX_CATEGORY_CHARS = 40;
// Filter value that selects items without a category (null selects everything).
export const UNCATEGORIZED = "";

export function todoProblem(text: string): TodoProblem | undefined {
  if (!text.trim()) return "empty";
  if (Array.from(text).length > MAX_TODO_CHARS) return "tooLong";
  if (text.includes("\0")) return "nul";
  return undefined;
}

// Trailing whitespace is dropped on save; leading indentation is kept.
export const cleanText = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");

export function normalizeCategory(value: string): string {
  return Array.from(value.replace(/\s+/g, " ").trim()).slice(0, MAX_CATEGORY_CHARS).join("");
}

export function categoriesOf(items: Todo[]): string[] {
  return [...new Set(items.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function filterTodos(items: Todo[], filter: string | null): Todo[] {
  return filter === null ? items : items.filter((item) => item.category === filter);
}

// What gets pasted into the terminal. One item goes as-is; several become a
// "- " list separated by blank lines. Nothing here appends Enter.
export function formatSend(items: Todo[]): string {
  const texts = items.map((item) => item.text.replace(/\r\n?/g, "\n").trim());
  if (texts.length === 1) return texts[0];
  return texts.map((text) => `- ${text.replace(/\n/g, "\n  ")}`).join("\n\n");
}
