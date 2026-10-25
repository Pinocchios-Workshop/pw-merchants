/**
 * Listy towaru: zapis w świecie, eksport i import — jeden format danych (zasada
 * „Jeden format danych: JSON” w PLAN.md).
 *
 * Lista to dokument JSON. Ten sam dokument leży w ustawieniu świata i trafia do pliku
 * eksportu, bez przerabiania. Odczyt z zapisu i import przechodzą przez jedną funkcję
 * `readStockList`: migracje do aktualnego schematu → uzupełnienie braków z `DEFAULTS`
 * → oczyszczenie. Pola, których moduł nie zna, zostają w dokumencie.
 *
 * Dokument listy:
 * { format: "pw-merchant.stock-list", schema: 1, id, name, mode: "manual" | "partyLevel",
 *   guaranteed, drawLimit,
 *   entries: [{ uuid, name, img, level, rarity, weight, limit, scroll }],      (limit: null = bez limitu)
 *   guaranteedEntries: [{ uuid, name, img, level, rarity, min, max, scroll }] }
 * `scroll` / `wand`: null = przedmiot; { rank } = zwój / różdżka z zaklęcia (uuid = zaklęcie,
 * patrz spell-consumables.js). Najwyżej jedno z nich.
 * Plik z kilkoma listami: { format: "pw-merchant.stock-lists", schema: 1, lists: [ … ] }.
 *
 * Listy są wspólne dla wszystkich sklepów świata: jedno ustawienie świata (`stockLists`),
 * bez pozycji w menu ustawień. Zapisywać może tylko MG.
 */
import { MODULE_ID } from "./constants.js";

const SETTING = "stockLists";

/** Nazwa formatu i aktualna wersja schematu. Schemat rośnie tylko przy zmianie znaczenia lub kształtu danych. */
export const LIST_FORMAT = "pw-merchant.stock-list";
export const BUNDLE_FORMAT = "pw-merchant.stock-lists";
export const SCHEMA = 1;

/** Wartości domyślne pól listy i pozycji (nowa opcja = nowy wpis tutaj, bez zmiany schematu). */
const DEFAULTS = Object.freeze({
  list: { name: "", mode: "manual", guaranteed: false, drawLimit: false, entries: [], guaranteedEntries: [] },
  entry: { uuid: null, name: "", img: "icons/svg/item-bag.svg", level: 0, rarity: "common", weight: 1, limit: null, scroll: null, wand: null },
  guaranteed: { uuid: null, name: "", img: "icons/svg/item-bag.svg", level: 0, rarity: "common", min: 1, max: 1, scroll: null, wand: null }
});

/**
 * Migracje: `MIGRATIONS[n]` przenosi dokument ze schematu n do n + 1. Od wydania 1.0
 * każda zmiana schematu dostaje tu krok i plik testowy starej wersji.
 * Schemat 0 = listy sprzed tego formatu (bez pól `format` i `schema`) — kształt już zgodny.
 */
const MIGRATIONS = {
  0: (doc) => doc
};

/** Rejestruje ustawienie (wywoływane w `init`). */
export function registerStockListsSetting() {
  game.settings.register(MODULE_ID, SETTING, {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });
  registerBackupSetting();
}

const whole = (value, min) => Math.max(min, Math.floor(Number(value) || 0));

/** Forma z zaklęcia ({ rank } z rangą 1–10) albo null. */
function readForm(form) {
  const rank = Number(form?.rank);
  return form && Number.isInteger(rank) && rank >= 1 && rank <= 10 ? { ...form, rank } : null;
}

/** Pozycja listy: braki z wartości domyślnych, oczyszczone pola znane, nieznane zostają. */
function readEntry(raw, defaults) {
  const e = { ...defaults, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    ...e,
    uuid: typeof e.uuid === "string" && e.uuid ? e.uuid : null,
    name: String(e.name ?? ""),
    img: String(e.img || defaults.img),
    level: Math.floor(Number(e.level) || 0),
    rarity: ["common", "uncommon", "rare", "unique"].includes(e.rarity) ? e.rarity : "common",
    // Zwój / różdżka z zaklęcia: ranga 1–10; inaczej zwykły przedmiot.
    scroll: readForm(e.scroll),
    wand: readForm(e.wand)
  };
}

/**
 * Jedyny odczyt dokumentu listy — z zapisu świata i z pliku importu.
 * @returns {{ list?: object, error?: string }}  `error` = klucz komunikatu (np. nowszy schemat)
 */
export function readStockList(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "PF2E_SHOP.StockLists.ImportInvalid" };
  if (raw.format && raw.format !== LIST_FORMAT) return { error: "PF2E_SHOP.StockLists.ImportInvalid" };
  let doc = foundry.utils.deepClone(raw);
  let schema = Number.isInteger(doc.schema) ? doc.schema : 0;
  if (schema > SCHEMA) return { error: "PF2E_SHOP.StockLists.ImportNewer" };
  for (; schema < SCHEMA; schema += 1) doc = (MIGRATIONS[schema] ?? ((d) => d))(doc);

  const list = { ...DEFAULTS.list, ...doc };
  const entries = (Array.isArray(list.entries) ? list.entries : []).map((e) => {
    const entry = readEntry(e, DEFAULTS.entry);
    return {
      ...entry,
      weight: whole(entry.weight, 0),
      limit: entry.limit === null || entry.limit === undefined || entry.limit === "" ? null : whole(entry.limit, 1)
    };
  });
  // Przedmioty gwarantowane: tylko gdy opcja jest włączona; ilość Min–Maks, Min ≤ Maks.
  const guaranteedEntries = (list.guaranteed && Array.isArray(list.guaranteedEntries) ? list.guaranteedEntries : []).map((e) => {
    const entry = readEntry(e, DEFAULTS.guaranteed);
    const min = whole(entry.min, 1);
    return { ...entry, min, max: Math.max(min, whole(entry.max, 1)) };
  });
  return {
    list: {
      ...list,
      format: LIST_FORMAT,
      schema: SCHEMA,
      id: typeof list.id === "string" && list.id ? list.id : null,
      name: String(list.name ?? "").trim(),
      mode: list.mode === "partyLevel" ? "partyLevel" : "manual",
      guaranteed: !!list.guaranteed,
      drawLimit: !!list.drawLimit,
      entries: entries.filter((e) => e.uuid || e.name),
      guaranteedEntries: guaranteedEntries.filter((e) => e.uuid || e.name)
    }
  };
}

/** Surowa zawartość ustawienia (tablica dokumentów). */
function rawLists() {
  const raw = game.settings.get(MODULE_ID, SETTING);
  return Array.isArray(raw) ? raw : [];
}

/** Wszystkie zapisane listy (kopie, odczytane przez `readStockList`; nieczytelne pomijane). */
export function getStockLists() {
  return rawLists().map((doc) => readStockList(doc).list).filter((list) => list?.id);
}

/**
 * Jedyny zapis ustawienia: podane listy + dokumenty, których ta wersja modułu nie umie
 * odczytać (np. zapisane przez nowszą wersję), bez zmian — żeby zapis ich nie skasował.
 */
async function writeLists(lists) {
  const kept = rawLists().filter((doc) => !readStockList(doc).list?.id);
  await game.settings.set(MODULE_ID, SETTING, [...lists, ...kept]);
}

/** Ustawienie z kopią list sprzed ostatniej migracji. */
const BACKUP_SETTING = "stockListsBackup";

/** Rejestruje ustawienie kopii list (wywoływane w `init`). */
function registerBackupSetting() {
  game.settings.register(MODULE_ID, BACKUP_SETTING, { scope: "world", config: false, type: Object, default: null });
}

/**
 * Przenosi zapisane listy do aktualnego schematu (migracja świata przy starcie, MG).
 * Przed zapisem kopia całego ustawienia trafia do `stockListsBackup`.
 * @returns {Promise<number>} liczba przeniesionych list
 */
export async function migrateStockLists() {
  const raw = rawLists();
  const old = raw.filter((doc) => doc && typeof doc === "object" && !(Number.isInteger(doc.schema) && doc.schema >= SCHEMA));
  if (!old.length) return 0;
  await game.settings.set(MODULE_ID, BACKUP_SETTING, {
    date: new Date().toISOString(),
    moduleVersion: game.modules.get(MODULE_ID)?.version ?? null,
    lists: JSON.parse(JSON.stringify(raw))
  });
  await game.settings.set(MODULE_ID, SETTING, raw.map((doc) => readStockList(doc).list ?? doc));
  return old.length;
}

/** Jedna zapisana lista po ID (kopia) albo null. */
export function getStockList(id) {
  return getStockLists().find((list) => list.id === id) ?? null;
}

/**
 * Zapisuje listę: nowa (bez ID) dostaje ID i trafia na koniec, istniejąca jest
 * podmieniana w miejscu. Zwraca zapisaną listę.
 */
export async function saveStockList(list) {
  const lists = getStockLists();
  const { list: saved } = readStockList({ ...list, id: list.id ?? foundry.utils.randomID() });
  const index = lists.findIndex((l) => l.id === saved.id);
  if (index >= 0) lists[index] = saved;
  else lists.push(saved);
  await writeLists(lists);
  return saved;
}

/** Usuwa listę o tym ID (nic nie robi, gdy jej nie ma). */
export async function deleteStockList(id) {
  const lists = getStockLists();
  const kept = lists.filter((l) => l.id !== id);
  if (kept.length !== lists.length) await writeLists(kept);
}

/**
 * Kopia listy pod nową nazwą („Nazwa (kopia)”, a gdy zajęta — „Nazwa (kopia 2)” itd.)
 * z nowym ID; zapisana od razu. Zwraca zapisaną kopię albo null.
 */
export async function duplicateStockList(id, copyName) {
  const source = getStockList(id);
  if (!source) return null;
  const names = new Set(getStockLists().map((l) => l.name));
  let name = copyName(source.name, 1);
  for (let n = 2; names.has(name); n += 1) name = copyName(source.name, n);
  return saveStockList({ ...source, id: null, name });
}

/** Zakres poziomów pozycji listy jako tekst („0–4”, „3”, „—” dla pustej). */
export function levelRange(entries = []) {
  if (!entries.length) return "—";
  const levels = entries.map((e) => Number(e.level) || 0);
  const min = Math.min(...levels);
  const max = Math.max(...levels);
  return min === max ? String(min) : `${min}–${max}`;
}

/* ---------------- Eksport i import ---------------- */

/** Tekst pliku eksportu jednej listy: ten sam dokument co w zapisie świata. */
export function exportStockList(id) {
  const list = getStockList(id);
  return list ? JSON.stringify(list, null, 2) : null;
}

/** Nazwa pliku eksportu: nazwa listy bez znaków niedozwolonych w nazwach plików. */
export function exportFileName(name) {
  const base = String(name || "stock-list").trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 80) || "stock-list";
  return `${base}.stock-list.json`;
}

/**
 * Odczyt pliku importu: jedna lista, plik z wieloma listami albo tablica list.
 * @returns {{ lists: object[], errors: string[] }}  `errors` = klucze komunikatów
 */
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { lists: [], errors: ["PF2E_SHOP.StockLists.ImportInvalid"] };
  }
  if (data?.format === BUNDLE_FORMAT && Number.isInteger(data.schema) && data.schema > SCHEMA) {
    return { lists: [], errors: ["PF2E_SHOP.StockLists.ImportNewer"] };
  }
  const raws = Array.isArray(data) ? data : data?.format === BUNDLE_FORMAT ? data.lists ?? [] : [data];
  const lists = [];
  const errors = [];
  for (const raw of raws) {
    const { list, error } = readStockList(raw);
    if (error) errors.push(error);
    else lists.push(list);
  }
  return { lists, errors };
}

/**
 * Zapisuje zaimportowane listy. `id` z pliku zostaje, gdy w świecie nie ma takiej listy;
 * gdy już jest (albo plik nie ma `id`) — lista dostaje nowe `id` i trafia jako osobna.
 * Lista o nazwie, która już jest w świecie, dostaje nazwę jak przy duplikowaniu
 * („Nazwa (kopia)”, „Nazwa (kopia 2)”…), gdy podano `copyName`.
 * @param {object[]} lists  wynik `parseImport`
 * @param {(name: string, n: number) => string} [copyName]
 * @returns {Promise<object[]>} zapisane listy
 */
export async function importStockLists(lists, copyName = null) {
  const all = getStockLists();
  const taken = new Set(all.map((l) => l.id));
  const names = new Set(all.map((l) => l.name));
  const saved = [];
  for (const list of lists) {
    const id = list.id && !taken.has(list.id) ? list.id : foundry.utils.randomID();
    taken.add(id);
    let name = list.name;
    if (copyName && names.has(name)) {
      name = copyName(list.name, 1);
      for (let n = 2; names.has(name); n += 1) name = copyName(list.name, n);
    }
    names.add(name);
    const { list: doc } = readStockList({ ...list, id, name });
    all.push(doc);
    saved.push(doc);
  }
  if (saved.length) await writeLists(all);
  return saved;
}
