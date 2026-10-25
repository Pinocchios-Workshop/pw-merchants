/**
 * Przełączniki kategorii w pasku filtrów, w jednej linii (jak tagi sklepu).
 *
 * Przełączniki, które nie mieszczą się w linii, są chowane, a w ich miejscu
 * pojawia się przycisk „+N”. Kliknięcie go rozwija listę wszystkich kategorii,
 * w której przełączniki działają tak samo (ukrywanie i pokazywanie kategorii
 * robi `filters.js` dla wszystkich przycisków `data-category-chip` naraz, więc
 * oba miejsca są zawsze zgodne). „+N” pokazuje samą liczbę schowanych kategorii.
 * Linia jest liczona od nowa przy zmianie szerokości okna i przy każdym włączeniu
 * albo wyłączeniu kategorii (wyłączona ma ikonę oka, więc jest szersza). Długa nazwa
 * kategorii jest skracana wielokropkiem (pełna nazwa w podpowiedzi).
 */
import { fitOneLine } from "./one-line.js";

/** Czy lista wszystkich kategorii jest rozwinięta (trzymane w oknie karty). */
const OPEN_KEY = "_psmChipsOpen";

export function activateCategoryChips(sheet, html) {
  const root = html.querySelector("[data-category-chips]");
  if (!root) return;
  const list = root.querySelector("[data-chips-list]");
  const more = root.querySelector("[data-chips-more]");
  const popover = root.querySelector("[data-chips-popover]");

  const fit = () => {
    fitOneLine(list, more, ":scope > [data-category-chip]");
    if (more?.hidden) setOpen(false);
  };

  const setOpen = (open) => {
    sheet[OPEN_KEY] = open;
    if (popover) popover.hidden = !open;
    more?.setAttribute("aria-expanded", String(open));
  };

  fit();
  setOpen(!!sheet[OPEN_KEY] && !more?.hidden);
  // Wyłączona kategoria dostaje ikonę oka i robi się szersza (także po „Resetuj
  // filtry”), więc po każdej zmianie stanu przełącznika liczymy linię od nowa.
  if (typeof MutationObserver === "function" && list) {
    const watcher = new MutationObserver(() => fit());
    watcher.observe(list, { attributes: true, attributeFilter: ["aria-pressed"], subtree: true });
    sheet._psmChipsWatcher?.disconnect();
    sheet._psmChipsWatcher = watcher;
  }
  if (typeof ResizeObserver === "function" && list) {
    const observer = new ResizeObserver(() => fit());
    observer.observe(root);
    sheet._psmChipsObserver?.disconnect();
    sheet._psmChipsObserver = observer;
  }

  more?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(popover?.hidden ?? false);
  });
  // Kliknięcie poza listą albo Escape zwija ją.
  html.addEventListener("pointerdown", (event) => {
    if (popover?.hidden) return;
    if (popover.contains(event.target) || more?.contains(event.target)) return;
    setOpen(false);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || popover?.hidden) return;
    event.stopPropagation();
    setOpen(false);
    more?.focus();
  });
}
