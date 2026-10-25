/**
 * Układ listy „All values” w Syntax Guide — czyste funkcje (bez DOM i Foundry, testy:
 * `node tests/run-tests.mjs`).
 *
 * Wartości mają iść od góry do dołu w kolumnach (alfabetycznie), a kolumny mają być zapełnione
 * równo, bez pustego „ogona” w ostatniej kolumnie. Liczbę wierszy każdej kolumny wyznacza więc
 * układ wirtualny „od lewej do prawej”: gdyby wartości leżały w rzędach po `columns` sztuk,
 * kolumna k dostałaby co `columns`-tą wartość zaczynając od k. Tyle sztuk ma w układzie
 * docelowym (alfabetycznie od góry): wszystkie kolumny mają tyle samo wartości albo o jedną
 * mniej (od prawej).
 */

/**
 * Ile wartości ma każda kolumna (od lewej): `ceil((total − k) / columns)`.
 * Kolumn nie bywa więcej niż wartości.
 * @param {number} total    liczba wartości
 * @param {number} columns  liczba kolumn
 * @returns {number[]}
 */
export function columnCounts(total, columns) {
  const n = Math.max(0, Math.floor(total) || 0);
  if (!n) return [];
  const cols = Math.min(n, Math.max(1, Math.floor(columns) || 1));
  return Array.from({ length: cols }, (_, k) => Math.ceil((n - k) / cols));
}

/**
 * Wartości rozłożone w kolumny: kolejność zostaje (z góry na dół, kolumna po kolumnie).
 * @template T
 * @param {T[]} items
 * @param {number} columns
 * @returns {T[][]}
 */
export function arrangeColumns(items, columns) {
  const result = [];
  let start = 0;
  for (const count of columnCounts(items.length, columns)) {
    result.push(items.slice(start, start + count));
    start += count;
  }
  return result;
}

/**
 * Ile kolumn się zmieści: kolumna ma szerokość `cellWidth` (najszerszej wartości), między
 * kolumnami `gap`. Co najmniej jedna, nie więcej niż wartości.
 * @param {number} width      dostępna szerokość (px)
 * @param {number} cellWidth  szerokość najszerszej wartości (px)
 * @param {number} gap        odstęp między kolumnami (px)
 * @param {number} total      liczba wartości
 */
export function columnsThatFit(width, cellWidth, gap, total) {
  const fit = Math.floor((Math.max(0, width) + gap) / (Math.max(1, cellWidth) + gap));
  return Math.max(1, Math.min(fit, Math.max(1, total)));
}
