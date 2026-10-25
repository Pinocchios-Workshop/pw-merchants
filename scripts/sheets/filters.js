/**
 * Filtry i sortowanie listy towaru na karcie sklepu.
 *
 * Działają tylko w oknie osoby, która ich używa: ukrywają wiersze albo całe kategorie
 * i układają wiersze w obrębie kategorii. Niczego nie zapisują w sklepie i nie
 * wpływają na to, co widzą inni. Stan jest trzymany w otwartym oknie karty: przetrwa
 * odświeżenie karty (np. po zmianie ilości), a po zamknięciu okna wraca do domyślnych.
 */

import { activateSearchChips } from "./search-chips.js";

/** Ustawienia domyślne. */
export const DEFAULT_FILTERS = Object.freeze({
  search: "",
  sort: "level",
  levelMin: null,
  levelMax: null,
  priceMin: null, // w gp
  priceMax: null
});

/** Klucz, pod którym okno karty trzyma stan filtrów. */
const STATE_KEY = "_psmFilterState";

function freshState() {
  return { ...DEFAULT_FILTERS, hiddenCategories: new Set() };
}

/** Stan filtrów otwartego okna karty (tworzony przy pierwszym renderowaniu). */
function getState(sheet) {
  return (sheet[STATE_KEY] ??= freshState());
}

/** Czyści stan filtrów okna (wywoływane przy zamknięciu okna). */
export function resetFilterState(sheet) {
  delete sheet[STATE_KEY];
}

/** Tekst do porównań: małe litery, bez polskich znaków i akcentów. */
export function normalize(text) {
  return String(text ?? "")
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .trim();
}

/** Liczba z pola albo null, gdy pole jest puste lub błędne. */
function readNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Porównania dla trybów sortowania (zawsze w obrębie kategorii). */
const collator = () => new Intl.Collator(game.i18n?.lang ?? "pl", { sensitivity: "base" });
export function comparator(sort) {
  const byName = collator();
  const name = (a, b) => byName.compare(a.name, b.name);
  const level = (a, b) => a.level - b.level;
  const price = (a, b) => a.price - b.price;
  switch (sort) {
    case "name":
      return (a, b) => name(a, b) || level(a, b);
    case "priceAsc":
      return (a, b) => price(a, b) || name(a, b);
    case "priceDesc":
      return (a, b) => -price(a, b) || name(a, b);
    case "level":
    default:
      return (a, b) => level(a, b) || name(a, b);
  }
}

/** Dane do filtrowania z nazwy, znaczników wyszukiwania (`trait:x`, `rarity:x`, `type:x`), poziomu i ceny (cp). */
export function filterRow({ name = "", tags = [], level = 0, price = 0 } = {}) {
  return { name, searchName: normalize(name), tags: new Set(tags.map(normalizeTag)), level: Number(level) || 0, price: Number(price) || 0 };
}

/**
 * Znacznik w porównywalnej postaci: jak `normalize`, spacje i podkreślenia → myślniki,
 * bez innych znaków („Rounds (Arquebus)” → „rounds-arquebus”, „Nightmare's” → „nightmares”).
 * Część przed pierwszym „:” (klucz, np. „weapon-group”) zostaje bez zmian.
 */
export function normalizeTag(text) {
  const value = normalize(text);
  const colon = value.indexOf(":");
  const clean = (part) => part.replace(/[\s_]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return colon < 0 ? clean(value) : `${value.slice(0, colon)}:${clean(value.slice(colon + 1))}`;
}

/**
 * Klucze wyszukiwania (opis i wszystkie wartości: SEARCH.md):
 * - `short` — forma skrócona klucza (np. „r:rare” = „rarity:rare”),
 * - `labels: false` — tylko wartości bazowe (nazwy systemowe PF2e, np. „martial”); etykiety
 *   („martial-weapon”, także w języku gry) nie działają.
 */
export const SEARCH_KEY_DEFS = Object.freeze({
  trait: { short: "t" },
  rarity: { short: "r" },
  type: { short: "ty" },
  // Skróty: pierwsza litera typu (a — armor, s — shield, w — weapon; am — ammunition i sp — spell,
  // żeby nie myliły się ze zbroją i tarczą) + litera klucza; kategoria zawsze „ct” (ac to armor-class).
  "weapon-category": { short: "wct", labels: false },
  "weapon-group": { short: "wg", labels: false },
  "weapon-base": { short: "wb", labels: false },
  "weapon-range": { short: "wr", labels: false },
  "armor-category": { short: "act", labels: false },
  "armor-group": { short: "ag", labels: false },
  "armor-base": { short: "ab", labels: false },
  "armor-class": { short: "ac", labels: false },
  "shield-class": { short: "sc", labels: false },
  "shield-base": { short: "sb", labels: false },
  "consumable-category": { short: "cct", labels: false },
  "ammunition-type": { short: "amt", labels: false },
  "spell-tradition": { short: "spt", labels: false }
});
/** Czy klucz przyjmuje także etykiety wartości (a nie tylko wartości bazowe). */
export const keyAcceptsLabels = (key) => SEARCH_KEY_DEFS[key]?.labels !== false;
/** Pełne nazwy kluczy. */
export const SEARCH_KEYS = Object.freeze(Object.keys(SEARCH_KEY_DEFS));
/** Formy skrócone → pełny klucz (z `short` w `SEARCH_KEY_DEFS`), np. „r” → „rarity”. */
export const SEARCH_KEY_SHORT = Object.freeze(
  Object.fromEntries(Object.entries(SEARCH_KEY_DEFS).filter(([, def]) => def.short).map(([key, def]) => [def.short, key]))
);
/** Pełny klucz dla zapisu pełnego albo skróconego (wielkość liter bez znaczenia). */
export const canonicalKey = (key) => {
  const k = String(key).toLowerCase();
  return SEARCH_KEY_SHORT[k] ?? k;
};
// Rozpoznawanie jednym wyrażeniem: pełne nazwy i skróty, dłuższe pierwsze.
const SEARCH_KEY = new RegExp(
  `^(${[...SEARCH_KEYS, ...Object.keys(SEARCH_KEY_SHORT)].sort((a, b) => b.length - a.length).join("|")}):(.*)$`,
  "i"
);

/** Jedna możliwość: znacznik „klucz:wartość” albo fragment nazwy; null dla pustej. */
export function parseTerm(word) {
  const match = SEARCH_KEY.exec(word);
  if (match) {
    const value = normalizeTag(match[2]);
    return value ? { tag: `${canonicalKey(match[1])}:${value}` } : null;
  }
  const text = normalize(word);
  return text ? { text } : null;
}

/**
 * Grupa „lub” ze słowa z „|”. Wszystkie możliwości dotyczą jednego klucza. Dwa zapisy,
 * nie do mieszania w jednym słowie:
 * - pełny: każda możliwość z tym samym kluczem — „weapon-group:axe|weapon-group:sword”,
 * - skrócony: klucz tylko przy pierwszej możliwości, kolejne bez dwukropka dostają ten sam
 *   klucz — „weapon-group:axe|sword”.
 * Słowo, które miesza oba zapisy, łączy dwa różne klucze albo ma nieznany klucz
 * („weapon-group:axe|sword|type:weapon”, „trait:acid|rarity:rare”, „weapon-group:axe|tag:x”),
 * daje pustą grupę — niczego nie znajdzie.
 * Gdy pierwsza możliwość nie ma klucza, możliwości to fragmenty nazwy albo znaczniki („potion|elixir”).
 * @returns {object[]|null}  możliwości `{ tag }` / `{ text }`; [] = błędny zapis; null = puste słowo
 */
export function parseGroup(word) {
  const parts = word.split("|").filter((part) => part.trim());
  if (!parts.length) return null;
  const first = SEARCH_KEY.exec(parts[0]);
  if (!first) return parts.map(parseTerm).filter(Boolean);
  const key = canonicalKey(first[1]);
  const rest = parts.slice(1);
  const bare = (part) => !part.includes(":");
  // „lub” działa w obrębie jednego klucza: kolejne możliwości muszą mieć ten sam klucz.
  const sameKey = (part) => canonicalKey(SEARCH_KEY.exec(part)?.[1] ?? "") === key;
  let terms;
  if (rest.every(bare)) terms = [parts[0], ...rest.map((part) => `${key}:${part}`)];
  else if (rest.every(sameKey)) terms = parts;
  else return []; // pomieszane zapisy, różne klucze albo nieznany klucz
  return terms.map(parseTerm).filter(Boolean);
}

/**
 * Rozbija wyszukiwanie (opis: SEARCH.md). Słowa rozdziela spacja:
 * - słowo „klucz:x” z kluczem z `SEARCH_KEYS` to znacznik (np. „trait:magical”),
 * - słowo z „|” to grupa „lub” (`parseGroup`): pasuje, gdy pasuje którakolwiek z możliwości
 *   (np. „weapon-group:axe|weapon-group:sword” albo skrótem „weapon-group:axe|sword”),
 * - słowo z „!” na początku to operator NOT: wyklucza znacznik („!rarity:rare”) albo fragment
 *   nazwy („!of”). Operatorów nie łączymy: „!” ze znakiem „|” (np. „!trait:acid|fire”)
 *   blokuje całe wyszukiwanie — niczego nie znajdzie.
 * - pozostałe słowa to szukana nazwa (fraza).
 * Wszystkie znaczniki, grupy i wykluczenia muszą pasować naraz.
 * @returns {{ text, tags, groups, notTags, notText, blocked }}
 */
export function parseSearch(search) {
  const words = String(search ?? "").trim().split(/\s+/).filter(Boolean);
  const tags = [];
  const groups = [];
  const text = [];
  const notTags = [];
  const notText = [];
  let blocked = false;
  for (const word of words) {
    // Operator NOT: „!” na początku słowa wyklucza znacznik albo fragment nazwy.
    if (word.startsWith("!") && word.length > 1) {
      const body = word.slice(1);
      if (body.includes("|")) { blocked = true; continue; } // nie łączymy operatorów (NOT + OR)
      const term = parseTerm(body);
      if (term?.tag) notTags.push(term.tag);
      else if (term?.text) notText.push(term.text);
      continue;
    }
    if (word.includes("|")) {
      const group = parseGroup(word);
      if (group) groups.push(group);
      continue;
    }
    const term = SEARCH_KEY.test(word) ? parseTerm(word) : null;
    if (term?.tag) tags.push(term.tag);
    else if (!SEARCH_KEY.test(word)) text.push(word);
  }
  return { text: normalize(text.join(" ")), tags, groups, notTags, notText, blocked };
}

/**
 * Czy wiersz spełnia warunki filtrów. Wiersz: { searchName, tags: Set, level, price (cp) }.
 * Ta sama funkcja filtruje wiersze karty sklepu i przedmioty w przeglądarce list towaru.
 */
export function matches(row, state) {
  const query = parseSearch(state.search);
  // NOT połączony z OR w jednym słowie — wyszukiwanie nie działa (niczego nie znajduje).
  if (query.blocked) return false;
  if (query.text && !row.searchName.includes(query.text)) return false;
  // Kilka znaczników: przedmiot musi mieć każdy z nich (cecha: nazwa systemowa albo etykieta).
  if (query.tags.some((tag) => !row.tags.has(tag))) return false;
  // Operator NOT: przedmiot nie może mieć wykluczonego znacznika ani fragmentu nazwy.
  if (query.notTags.some((tag) => row.tags.has(tag))) return false;
  if (query.notText.some((t) => row.searchName.includes(t))) return false;
  // Grupy „lub”: w każdej grupie pasuje co najmniej jedna możliwość.
  const fits = (term) => (term.tag ? row.tags.has(term.tag) : row.searchName.includes(term.text));
  if (query.groups.some((group) => !group.some(fits))) return false;
  if (state.levelMin !== null && row.level < state.levelMin) return false;
  if (state.levelMax !== null && row.level > state.levelMax) return false;
  if (state.priceMin !== null && row.price < Math.round(state.priceMin * 100)) return false;
  if (state.priceMax !== null && row.price > Math.round(state.priceMax * 100)) return false;
  return true;
}

/** Czy jakikolwiek filtr zawęża listę (sortowanie i ukryte kategorie się nie liczą). */
export function isFiltering(state) {
  return !!state.search || ["levelMin", "levelMax", "priceMin", "priceMax"].some((k) => state[k] !== null);
}

/** Czy cokolwiek odbiega od ustawień domyślnych (dla przycisku resetu). */
export function isChanged(state) {
  return isFiltering(state) || state.sort !== DEFAULT_FILTERS.sort || state.hiddenCategories.size > 0;
}

/** Stosuje filtry i sortowanie do wyrenderowanej listy. */
export function applyFilters(html, state) {
  const sort = comparator(state.sort);
  const filtering = isFiltering(state);

  // Ukryte kategorie: sekcja znika, przełącznik jest wyszarzony.
  for (const chip of html.querySelectorAll("[data-category-chip]")) {
    const hidden = state.hiddenCategories.has(chip.dataset.categoryChip);
    chip.setAttribute("aria-pressed", String(!hidden));
  }
  for (const section of html.querySelectorAll(".psm-category[data-category-id]")) {
    section.hidden = state.hiddenCategories.has(section.dataset.categoryId);
  }

  for (const section of html.querySelectorAll(".psm-category[data-category-id]")) {
    const list = section.querySelector(":scope > .psm-items");
    if (!list) continue;
    const rows = [...list.querySelectorAll(":scope > li[data-item-id]")].map((el) => ({
      el,
      name: el.dataset.name ?? "",
      searchName: normalize(el.dataset.name),
      tags: new Set(String(el.dataset.tags ?? "").split("|").filter(Boolean).map(normalizeTag)),
      level: Number(el.dataset.level) || 0,
      price: Number(el.dataset.price) || 0
    }));
    if (!rows.length) continue;

    rows.sort(sort);
    let visible = 0;
    for (const row of rows) {
      const show = matches(row, state);
      row.el.hidden = !show;
      row.el.classList.toggle("odd", show && visible % 2 === 1);
      if (show) visible += 1;
      list.append(row.el); // nowa kolejność
    }

    const noMatch = list.querySelector(":scope > .psm-item--no-match");
    if (noMatch) {
      noMatch.hidden = visible > 0;
      list.append(noMatch);
    }
    const count = section.querySelector("[data-count-total]");
    if (count) count.textContent = filtering ? `${visible}/${rows.length}` : `${rows.length}`;
  }

  const reset = html.querySelector("[data-filter-reset]");
  if (reset) reset.disabled = !isChanged(state);
}

/** Ponownie stosuje filtry okna (np. po odblokowaniu pól przez moduł). */
export function refreshFilters(html, sheet) {
  if (sheet?.[STATE_KEY]) applyFilters(html, sheet[STATE_KEY]);
}

/** Wpisuje stan do pól formularza. */
function writeInputs(html, state) {
  for (const input of html.querySelectorAll("[data-filter]")) {
    const value = state[input.dataset.filter];
    const text = value === null || value === undefined ? "" : String(value);
    // Pole wyszukiwania: znaczniki trait:/rarity: jako oznaczenia, reszta jako tekst.
    if (input[SEARCH_CHIPS]) input[SEARCH_CHIPS].set(text);
    else input.value = text;
  }
}

/** Oznaczenia pola wyszukiwania (search-chips.js), przypięte do pola. */
const SEARCH_CHIPS = Symbol("psmSearchChips");

/** Wartość pola filtra (wyszukiwanie: oznaczenia + tekst). */
function readInput(input) {
  const key = input.dataset.filter;
  if (key === "search") return input[SEARCH_CHIPS]?.value() ?? input.value;
  return key === "sort" ? input.value : readNumber(input.value);
}

/**
 * Podpina filtry pod wyrenderowaną kartę sklepu.
 * @param {HTMLElement} html  element karty
 * @param {object} sheet      okno karty (trzyma stan filtrów)
 * @param {object} [options]
 * @param {Function} [options.apply]  własne zastosowanie filtrów (html, state); domyślnie ukrywanie
 *        wierszy w wyrenderowanej liście (karta sklepu). Przeglądarka list towaru filtruje dane.
 */
export function activateFilters(html, sheet, { apply = applyFilters } = {}) {
  const state = getState(sheet);
  let timer = null;
  const update = (input) => {
    const key = input.dataset.filter;
    const value = readInput(input);
    // Ta sama wartość (np. „change” po opuszczeniu pola, Enter po odczekaniu) nie przebudowuje listy
    // — inaczej kliknięcie w wiersz zaraz po wpisaniu frazy przebudowywało listę pod kursorem.
    if (state[key] === value) return;
    state[key] = value;
    apply(html, state);
  };

  // „?” przy polu wyszukiwania: okno Syntax Guide (import przy kliknięciu — bez zależności w kółko).
  html.querySelector("[data-search-help]")?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const { SyntaxGuide } = await import("../apps/syntax-guide.js");
    SyntaxGuide.open();
  });

  const search = html.querySelector('[data-filter="search"]');
  if (search) search[SEARCH_CHIPS] = activateSearchChips(search, () => update(search));
  writeInputs(html, state);
  apply(html, state);

  for (const input of html.querySelectorAll("[data-filter]")) {
    // Zmiany filtrów nie mogą trafić do formularza karty PF2e ani go wysłać.
    input.addEventListener("change", (event) => {
      event.stopPropagation();
      update(input);
    });
    input.addEventListener("input", (event) => {
      event.stopPropagation();
      clearTimeout(timer);
      timer = setTimeout(() => update(input), input.dataset.filter === "search" ? 150 : 250);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      update(input);
    });
  }

  // Przełączniki kategorii: kliknięcie ukrywa albo pokazuje kategorię.
  for (const chip of html.querySelectorAll("[data-category-chip]")) {
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      const id = chip.dataset.categoryChip;
      if (state.hiddenCategories.has(id)) state.hiddenCategories.delete(id);
      else state.hiddenCategories.add(id);
      apply(html, state);
    });
  }

  html.querySelector("[data-filter-reset]")?.addEventListener("click", (event) => {
    event.preventDefault();
    Object.assign(state, freshState());
    writeInputs(html, state);
    apply(html, state);
  });
}
