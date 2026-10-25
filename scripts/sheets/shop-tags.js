/**
 * Tagi sklepu w nagłówku karty.
 *
 * Tagi zajmują jedną linię pod nazwą sklepu. Te, które się w niej nie mieszczą,
 * są chowane, a w ich miejscu pojawia się przycisk „+N”. Kliknięcie go rozwija
 * pod nagłówkiem listę wszystkich tagów (MG może w niej też usuwać tagi).
 * Dopasowanie jest liczone po każdym renderowaniu i przy zmianie szerokości okna.
 *
 * MG dodaje tagi przyciskiem „+”: pojawia się pole, Enter albo wyjście z pola
 * zapisuje tag, Escape anuluje.
 */
import { addShopTag } from "../shop-data.js";
import { fitOneLine } from "./one-line.js";

/** Czy lista wszystkich tagów jest rozwinięta (trzymane w oknie karty). */
const OPEN_KEY = "_psmTagsOpen";

export function activateShopTags(sheet, html) {
  const root = html.querySelector("[data-shop-tags]");
  if (!root) return;
  const list = root.querySelector("[data-shop-tags-list]");
  const more = root.querySelector("[data-shop-tags-more]");
  const popover = root.querySelector("[data-shop-tags-popover]");

  const fit = () => fitTags(list, more);
  fit();
  // Zmiana szerokości okna (albo pokazanie pola dodawania) przelicza tagi.
  if (typeof ResizeObserver === "function" && list) {
    const observer = new ResizeObserver(() => fit());
    observer.observe(root);
    sheet._psmTagsObserver?.disconnect();
    sheet._psmTagsObserver = observer;
  }

  // „+N”: rozwija i zwija listę wszystkich tagów.
  const setOpen = (open) => {
    sheet[OPEN_KEY] = open;
    if (popover) popover.hidden = !open;
    more?.setAttribute("aria-expanded", String(open));
  };
  setOpen(!!sheet[OPEN_KEY] && !more?.hidden);
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

  activateTagInput(sheet, root, fit);
}

/** Tagi w jednej linii, reszta pod „+N” (wspólna logika z przełącznikami kategorii). */
function fitTags(list, more) {
  fitOneLine(list, more, ":scope > .psm-shop-tag");
}

/** Pole dodawania tagu (MG). */
function activateTagInput(sheet, root, fit) {
  const input = root.querySelector("[data-shop-tag-input]");
  const add = root.querySelector("[data-shop-tag-add]");
  if (!input || !add) return;

  const open = () => {
    add.hidden = true;
    input.hidden = false;
    input.focus();
    fit();
  };
  const close = () => {
    input.value = "";
    input.hidden = true;
    add.hidden = false;
    fit();
  };
  const save = async () => {
    const value = input.value;
    close();
    if (value.trim()) await addShopTag(sheet.actor, value);
  };

  add.addEventListener("click", (event) => {
    event.preventDefault();
    open();
  });
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  // Wyjście z pola zapisuje wpisany tag, puste pole po prostu się chowa.
  input.addEventListener("blur", async () => {
    if (!input.hidden) await save();
  });
  input.addEventListener("change", (event) => event.stopPropagation());
}
