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
