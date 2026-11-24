/**
 * Keeps a text on ONE line by shrinking its font size until it fits (never below `minPx`).
 * The element must be a block/flex item with a bounded width (`min-width: 0`, `white-space: nowrap`,
 * `overflow: hidden` in CSS). Re-fits when the element is resized or its text changes.
 */
const DEFAULT_MIN_PX = 6;
const STEP_PX = 0.5;

const mins = new WeakMap();
let resizeObserver = null;
let mutationObserver = null;

function fit(el) {
  const minPx = mins.get(el) ?? DEFAULT_MIN_PX;
  el.style.fontSize = '';
  el.title = el.textContent; // full @ on hover, in case it ends up tiny
  if (!el.clientWidth) return; // not laid out yet; the ResizeObserver will call us back
  let size = parseFloat(getComputedStyle(el).fontSize) || 16;
  while (el.scrollWidth > el.clientWidth + 0.5 && size > minPx) {
    size = Math.max(minPx, size - STEP_PX);
    el.style.fontSize = `${size}px`;
  }
}

export function autoFitText(el, { minPx = DEFAULT_MIN_PX } = {}) {
  if (!el || mins.has(el)) return el;
  mins.set(el, minPx);

  if (typeof ResizeObserver === 'function') {
    resizeObserver ??= new ResizeObserver((entries) => {
      for (const entry of entries) fit(entry.target);
    });
    resizeObserver.observe(el);
  }
  if (typeof MutationObserver === 'function') {
    mutationObserver ??= new MutationObserver((records) => {
      for (const record of new Set(records.map((r) => r.target.nodeType === 1 ? r.target : r.target.parentElement))) {
        if (record && mins.has(record)) fit(record);
      }
    });
    mutationObserver.observe(el, { childList: true, characterData: true, subtree: true });
  }
  fit(el);
  return el;
}
