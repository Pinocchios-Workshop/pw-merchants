/**
 * Lista „All values” w Syntax Guide: każda wartość klucza jako para „tekst do wpisania, pod nim
 * oznaczenie” (to samo oznaczenie co w polu wyszukiwania, `searchTagPreview`), wyśrodkowana
 * w swojej kolumnie.
 *
 * Układ (obliczenia: guide-layout.js):
 * - wartości alfabetycznie, od góry do dołu w kolumnach,
 * - szerokość kolumny = szerokość najszerszej wartości (tekst albo oznaczenie), zmierzona raz,
 *   więc nic się nie przycina,
 * - liczba kolumn (najwięcej 5) wynika z szerokości okna i jest przeliczana przy zmianie jego rozmiaru;
 *   kolumny są zapełnione równo (wiersze liczone układem wirtualnym „od lewej do prawej”).
 * Elementy wartości powstają raz i są tylko przestawiane między kolumnami.
 */
import { searchTagPreview } from "../sheets/search-chips.js";
import { arrangeColumns, columnsThatFit } from "./guide-layout.js";

/** Odstęp między kolumnami (px) — ten sam co `column-gap` w `.psm-guide__values` (shop.css). */
const GAP = 12;
/** Najwięcej kolumn listy (nawet w szerokim oknie). */
const MAX_COLUMNS = 5;

/** Jedna wartość: tekst do wpisania, pod nim oznaczenie. */
function valueCell(key, value) {
  const cell = document.createElement("div");
  cell.className = "psm-guide__value";
  const code = document.createElement("code");
  code.textContent = value;
  cell.append(code);
  const tag = searchTagPreview(`${key}:${value}`);
  if (tag) cell.append(tag);
  return cell;
}

/**
 * Wypełnia kontener listą wartości klucza.
 * @param {HTMLElement} container  `.psm-guide__values` (siatka kolumn)
 * @param {string[]} values        wartości (kolejność zostanie zamieniona na alfabetyczną)
 * @param {string} key             klucz wyszukiwania (np. "trait")
 */
export function renderValues(container, values, key) {
  // Alfabetycznie; liczby rosnąco wartością („10, 15, … 300”), nie znak po znaku.
  const sorted = [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const cells = sorted.map((value) => valueCell(key, value));

  // Najszersza wartość: wszystkie naraz w niewidocznym, dopasowanym do treści bloku (jeden pomiar).
  const probe = document.createElement("div");
  probe.className = "psm-guide__probe";
  probe.append(...cells);
  container.append(probe);
  const cellWidth = Math.ceil(Math.max(0, ...cells.map((cell) => cell.getBoundingClientRect().width)));
  probe.remove();

  let columns = 0;
  const layout = () => {
    const style = getComputedStyle(container);
    const width = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (!(width > 0)) return; // zwinięte albo jeszcze bez rozmiaru
    const next = Math.min(MAX_COLUMNS, columnsThatFit(width, cellWidth, GAP, cells.length));
    if (next === columns) return;
    columns = next;
    container.style.setProperty("--psm-guide-cols", String(next));
    container.replaceChildren(
      ...arrangeColumns(cells, next).map((group) => {
        const column = document.createElement("div");
        column.className = "psm-guide__col";
        column.append(...group);
        return column;
      })
    );
  };
  layout();
  new ResizeObserver(layout).observe(container);
}
