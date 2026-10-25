/**
 * Wspólne dopasowanie listy do jednej linii (tagi sklepu, przełączniki kategorii).
 *
 * Pokazuje tyle elementów, ile mieści się w linii; resztę chowa od końca
 * i wpisuje ich liczbę na przycisk „+N”. Gdy wszystko się mieści, „+N” znika.
 * @param {HTMLElement} list      kontener elementów (jedna linia, overflow: hidden)
 * @param {HTMLElement} more      przycisk „+N”
 * @param {string} selector       elementy listy, np. ":scope > .psm-shop-tag"
 */
export function fitOneLine(list, more, selector) {
  if (!list || !more) return;
  const items = [...list.querySelectorAll(selector)];
  for (const item of items) item.hidden = false;
  more.hidden = true;
  if (!items.length) return;

  const limit = () => list.getBoundingClientRect().right;
  const overflows = () => items.some((item) => !item.hidden && item.getBoundingClientRect().right > limit() + 0.5);
  if (!overflows()) return;

  more.hidden = false;
  let hidden = 0;
  for (let i = items.length - 1; i >= 0 && overflows(); i--) {
    items[i].hidden = true;
    hidden += 1;
    more.textContent = `+${hidden}`;
  }
  more.textContent = `+${hidden}`;
}
