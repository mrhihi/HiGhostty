// Instant tooltip for elements carrying `data-tip`. The native `title` tooltip waits about a second
// and cannot be tuned, so badges that are hovered often use this instead.
let tip: HTMLElement | null = null;
let current: HTMLElement | null = null;

function hide() {
  current = null;
  if (tip) tip.hidden = true;
}

function show(target: HTMLElement) {
  const text = target.dataset.tip;
  if (!text) return hide();
  current = target;
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "tooltip";
    tip.setAttribute("role", "tooltip");
    document.body.append(tip);
  }
  tip.textContent = text;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const below = r.bottom + 6 + h <= window.innerHeight;
  tip.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
  tip.style.top = `${below ? r.bottom + 6 : Math.max(4, r.top - 6 - h)}px`;
}

export function initTooltips() {
  document.addEventListener("mouseover", (e) => {
    const target = (e.target as Element | null)?.closest<HTMLElement>("[data-tip]") ?? null;
    if (target === current) return;
    if (target) show(target);
    else hide();
  });
  document.addEventListener("mousedown", hide, true);
  window.addEventListener("blur", hide);
}
