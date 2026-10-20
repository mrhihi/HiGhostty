// Pointer-based row reordering. Tauri's window drag-drop handling swallows HTML5 drag and
// drop inside the page, so rows follow the pointer and their neighbours slide aside live.

// Where the dragged row would land: the number of other rows whose center is above it.
export function insertPosition(centers: number[], dragged: number): number {
  return centers.filter((center) => center < dragged).length;
}

const THRESHOLD = 5;

// A tab row with sub-tabs moves together with the rows right under it.
function unitOf(row: HTMLElement): HTMLElement[] {
  const unit = [row];
  if (!row.classList.contains("tab-parent")) return unit;
  let next = row.nextElementSibling;
  while (next instanceof HTMLElement && next.dataset.dragKind?.startsWith("child:")) { unit.push(next); next = next.nextElementSibling; }
  return unit;
}
const shiftTo = (unit: HTMLElement[], offset: number) => { for (const element of unit) element.style.transform = offset ? `translateY(${offset}px)` : ""; };

// Rows with the same data-drag-kind under the same parent can be reordered among themselves.
// onDrop gets the moved row and the row it now sits in front of (undefined: at the end).
// With crossBlock, rows of the same kind can also be dropped into another .tab-block: the
// neighbours stop sliding, an insertion line marks the spot, and onDrop gets that block too.
export function enableRowDrag(row: HTMLElement, onDrop: (moving: HTMLElement, before: HTMLElement | undefined, block?: HTMLElement) => void, crossBlock = false) {
  row.addEventListener("pointerdown", (down) => {
    if (down.button !== 0 || down.ctrlKey || (down.target instanceof Element && down.target.closest("input, .tab-more, .row-action"))) return;
    const startY = down.clientY;
    let started = false;
    let others: { row: HTMLElement; unit: HTMLElement[]; center: number }[] = [];
    let unit: HTMLElement[] = [];
    let height = 0, ownCenter = 0, ownIndex = 0, target = 0;
    let origin: Element | null = null;
    let crossTo: { block: HTMLElement; before: HTMLElement | undefined } | undefined;
    const clearMarks = () => { for (const el of document.querySelectorAll(".drop-target, .drop-before, .drop-end")) el.classList.remove("drop-target", "drop-before", "drop-end"); };
    const begin = () => {
      started = true;
      unit = unitOf(row);
      const kind = row.dataset.dragKind, id = row.dataset.dragId;
      const parent = row.parentElement;
      origin = row.closest(".tab-block");
      const all = Array.from(parent?.children ?? []).filter((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.dragKind === kind);
      const span = (items: HTMLElement[]) => ({ top: items[0].getBoundingClientRect().top, bottom: items.at(-1)!.getBoundingClientRect().bottom });
      const own = span(unit);
      ownCenter = (own.top + own.bottom) / 2;
      const after = unit.at(-1)!.nextElementSibling;
      height = (after ? after.getBoundingClientRect().top : own.bottom) - own.top;
      const skip = new Set(unit);
      others = all.filter((el) => !skip.has(el) && el.dataset.dragId !== id)
        .map((el) => { const u = unitOf(el); const s = span(u); return { row: el, unit: u, center: (s.top + s.bottom) / 2 }; });
      ownIndex = others.filter((item) => item.center < ownCenter).length;
      target = ownIndex;
      for (const item of others) for (const element of item.unit) element.classList.add("row-sliding");
      for (const element of unit) element.classList.add("row-dragged");
      document.body.classList.add("row-dragging");
    };
    // The other block under the pointer (nearest one vertically), with the row to insert before.
    const crossTarget = (y: number) => {
      const blocks = Array.from(document.querySelectorAll<HTMLElement>("#tabs .tab-block"));
      let best: HTMLElement | undefined, bestDistance = Infinity;
      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
        if (distance < bestDistance) { best = block; bestDistance = distance; }
      }
      if (!best || best === origin) return undefined;
      const id = row.dataset.dragId, kind = row.dataset.dragKind;
      const rows = Array.from(best.querySelectorAll<HTMLElement>("[data-drag-kind]"))
        .filter((el) => el.dataset.dragKind === kind && el.dataset.dragId !== id && el.getClientRects().length);
      return { block: best, before: rows.find((el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2 > y; }) };
    };
    const move = (event: PointerEvent) => {
      const dy = event.clientY - startY;
      if (!started) { if (Math.abs(dy) < THRESHOLD) return; begin(); }
      shiftTo(unit, dy);
      crossTo = crossBlock ? crossTarget(event.clientY) : undefined;
      clearMarks();
      if (crossTo) {
        crossTo.block.classList.add("drop-target");
        crossTo.before?.classList.add("drop-before");
        if (!crossTo.before) crossTo.block.classList.add("drop-end");
        others.forEach((item) => shiftTo(item.unit, 0));
        return;
      }
      target = insertPosition(others.map((item) => item.center), ownCenter + dy);
      others.forEach((item, index) => shiftTo(item.unit, target > ownIndex && index >= ownIndex && index < target ? -height : target < ownIndex && index >= target && index < ownIndex ? height : 0));
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (!started) return;
      for (const element of [...unit, ...others.flatMap((item) => item.unit)]) { element.classList.remove("row-sliding", "row-dragged"); element.style.transform = ""; }
      document.body.classList.remove("row-dragging");
      clearMarks();
      // The click that follows a drag must not activate the row.
      const swallow = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 60);
      if (commit && crossTo) onDrop(row, crossTo.before, crossTo.block);
      else if (commit && target !== ownIndex) onDrop(row, others[target]?.row);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  });
}
