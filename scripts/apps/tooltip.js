/**
 * Podpowiedzi modułu (zamiast podpowiedzi Foundry `data-tooltip`) — jedno miejsce dla
 * wszystkich okien modułu. Element z `data-psm-tooltip="tekst"` pokazuje podpowiedź:
 * - po stałym czasie liczonym osobno dla każdego elementu (przejście z jednej podpowiedzi
 *   na sąsiedni element nie pokazuje od razu następnej — czas liczy się od nowa),
 * - przy kursorze myszy (pod nim, przesunięta, zawsze w granicach ekranu).
 * Znika po zjechaniu z elementu, kliknięciu, przewinięciu albo klawiszu.
 */

/** Opóźnienie pokazania podpowiedzi (ms). */
const DELAY = 600;
/** Przesunięcie podpowiedzi względem kursora (px). */
const OFFSET = { x: 14, y: 20 };
const ATTR = "data-psm-tooltip";

let tip = null;
let timer = null;
let current = null;
const pointer = { x: 0, y: 0 };

function element() {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "psm-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function hide() {
  clearTimeout(timer);
  timer = null;
  current = null;
  if (tip) tip.hidden = true;
}

function show(target) {
  const text = target.getAttribute(ATTR);
  if (!text || !target.isConnected) return;
  const el = element();
  el.textContent = text;
  el.hidden = false;
  const { width, height } = el.getBoundingClientRect();
  let x = pointer.x + OFFSET.x;
  let y = pointer.y + OFFSET.y;
  if (x + width > innerWidth - 8) x = Math.max(8, pointer.x - OFFSET.x - width);
  if (y + height > innerHeight - 8) y = Math.max(8, pointer.y - OFFSET.y - height);
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

/** Włącza podpowiedzi modułu (raz, przy starcie). */
export function activateTooltips() {
  if (globalThis.__psmTooltips) return;
  globalThis.__psmTooltips = true;
  document.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  }, { passive: true });
  document.addEventListener("pointerover", (event) => {
    const target = event.target.closest?.(`[${ATTR}]`);
    if (target === current) return;
    hide();
    if (!target) return;
    current = target;
    timer = setTimeout(() => current === target && show(target), DELAY);
  });
  document.addEventListener("pointerout", (event) => {
    if (!current) return;
    if (event.relatedTarget && current.contains(event.relatedTarget)) return;
    if (event.target.closest?.(`[${ATTR}]`) === current) hide();
  });
  for (const type of ["pointerdown", "wheel", "keydown"]) document.addEventListener(type, hide, { passive: true, capture: true });
}
