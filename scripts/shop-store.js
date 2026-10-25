/**
 * Dane sklepu: jeden wersjonowany format (zasada „Jeden format danych: JSON” w PLAN.md).
 *
 * Dokument sklepu = flagi modułu na aktorze sklepu:
 *   flags[MODULE_ID] = {
 *     schema: 1,
 *     shop:       { priceModifier, tags: [] },
 *     categories: [{ id, name, tables: [{ listId | uuid, countMin, countMax }] }],
 *     backup?:    kopia danych sprzed ostatniej migracji (patrz `migrateWorld`)
 *   }
 * Flagi modułu na przedmiocie w sklepie:
 *   flags[MODULE_ID] = { schema: 1, category: id | null, basePrice: { gp, sp, cp } | null }
 *
 * Zasady (ARCHITECTURE.md, „Kontrakt danych”):
 * - Każdy odczyt przechodzi przez `readShopDoc` / `readItemFlags`: migracje do aktualnego
 *   schematu → wartości domyślne → oczyszczenie. Pola, których moduł nie zna, zostają.
 * - Każdy zapis przechodzi przez `writeShop` / `writeItemFlags` i zapisuje dokument
 *   w aktualnym schemacie (nigdy pół starego, pół nowego kształtu).
 * - Dane zapisane przez nowszą wersję modułu (`schema` > `SHOP_SCHEMA`) są czytane
 *   „jak się da”, ale nie są nadpisywane — sklep jest tylko do odczytu.
 * - Nowe pole = nowy wpis w `DEFAULTS`, bez zmiany schematu. Zmiana znaczenia albo
 *   kształtu = nowy numer schematu, krok w `SHOP_MIGRATIONS` / `ITEM_MIGRATIONS`
 *   i plik testowy starej wersji w `tests/fixtures/`.
 *
 * Funkcje odczytu są czyste (bez Foundry) — testy: `node tests/run-tests.mjs`.
 */
import { MODULE_ID } from "./constants.js";

/** Aktualna wersja schematu danych sklepu (aktor i przedmioty). */
export const SHOP_SCHEMA = 1;

/** Wartości domyślne pól (nowa opcja = nowy wpis tutaj, bez zmiany schematu). */
export const SHOP_DEFAULTS = Object.freeze({
  shop: Object.freeze({ priceModifier: 1, tags: Object.freeze([]) }),
  category: Object.freeze({ name: "", tables: Object.freeze([]) }),
  item: Object.freeze({ category: null, basePrice: null })
});

/**
 * Migracje dokumentu sklepu: `SHOP_MIGRATIONS[n]` przenosi flagi aktora ze schematu n
 * do n + 1. Nie zmieniają przekazanego obiektu — zwracają nowy.
 */
const SHOP_MIGRATIONS = {
  /**
   * 0 → 1: dane sprzed wersjonowania. Starsze kategorie miały jedną tabelę losową
   * (`tableUuid`) i zakres na kategorii (`countMin`/`countMax`, a jeszcze wcześniej
   * jedną liczbę `count`) — stają się pierwszym (jedynym) slotem z tym samym zakresem.
   */
  0: (doc) => ({
    ...doc,
    categories: Array.isArray(doc.categories)
      ? doc.categories.map((c) => {
          if (!c || typeof c !== "object" || Array.isArray(c.tables)) return c;
          const { tableUuid, count, countMin, countMax, ...rest } = c;
          return {
            ...rest,
            tables: tableUuid ? [{ uuid: tableUuid, countMin: countMin ?? count, countMax: countMax ?? count }] : []
          };
        })
      : doc.categories
  })
};

/**
 * Migracje flag przedmiotu: `ITEM_MIGRATIONS[n]` przenosi flagi ze schematu n do n + 1.
 */
const ITEM_MIGRATIONS = {
  /** 0 → 1: własna cena bez platyny — pp przeliczone na gp (1 pp = 10 gp). */
  0: (flags) => {
    const price = flags.basePrice;
    if (!price || typeof price !== "object" || !(Number(price.pp) > 0)) return flags;
    const { pp, ...rest } = price;
    return { ...flags, basePrice: { ...rest, gp: (Number(rest.gp) || 0) + Number(pp) * 10 } };
  }
};

/* ---------------- Pomocnicze ---------------- */

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const schemaOf = (doc) => (Number.isInteger(doc?.schema) && doc.schema >= 0 ? doc.schema : 0);

/** Mnożnik w dozwolonym zakresie 0–2 (0–200%), z dokładnością do 1%. */
export function clampModifier(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SHOP_DEFAULTS.shop.priceModifier;
  return Math.round(Math.min(2, Math.max(0, n)) * 100) / 100;
}

/**
 * Liczba przedmiotów do wylosowania: tylko liczba całkowita ≥ 0, inaczej null.
 * Przyjmuje liczbę albo tekst z pola („5”, ale nie „-1”, „2.5”, „abc”, „”).
 */
export function toCount(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/* ---------------- Odczyt (czyste funkcje) ---------------- */

/** Ustawienia sklepu: braki z wartości domyślnych, znane pola oczyszczone, nieznane zostają. */
function cleanShop(raw) {
  const shop = { ...SHOP_DEFAULTS.shop, ...(isObject(raw) ? raw : {}) };
  return {
    ...shop,
    priceModifier: clampModifier(shop.priceModifier),
    tags: Array.isArray(shop.tags) ? shop.tags.filter((t) => typeof t === "string" && t.trim()) : []
  };
}

/** Slot kategorii: źródło (lista towaru albo starsza tabela losowa) i zakres „od–do”. */
function cleanSlot(raw) {
  if (!isObject(raw)) return null;
  const { listId, uuid, ...rest } = raw;
  const hasList = typeof listId === "string" && !!listId;
  if (!hasList && !(typeof uuid === "string" && uuid)) return null;
  const countMin = toCount(rest.countMin) ?? 0;
  const countMax = Math.max(countMin, toCount(rest.countMax) ?? countMin);
  return { ...(hasList ? { listId } : { uuid }), ...rest, countMin, countMax };
}

/** Kategoria: id (wymagane), nazwa, sloty; nieznane pola zostają. */
function cleanCategory(raw) {
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id) return null;
  const category = { ...SHOP_DEFAULTS.category, ...raw };
  return {
    ...category,
    name: String(category.name ?? ""),
    tables: (Array.isArray(category.tables) ? category.tables : []).map(cleanSlot).filter(Boolean)
  };
}

/**
 * Jedyny odczyt dokumentu sklepu (flag modułu na aktorze).
 * @param {object|undefined} raw  `actor.flags[MODULE_ID]`
 * @returns {{ doc: { schema, shop, categories, … }, schema: number, newer: boolean }}
 *   `schema` = wersja zapisu przed migracją; `newer` = zapis z nowszej wersji modułu
 *   (czytany „jak się da”, bez migracji; nie wolno go nadpisywać)
 */
export function readShopDoc(raw) {
  let doc = isObject(raw) ? raw : {};
  const stored = schemaOf(doc);
  const newer = stored > SHOP_SCHEMA;
  if (!newer) for (let s = stored; s < SHOP_SCHEMA; s += 1) doc = (SHOP_MIGRATIONS[s] ?? ((d) => d))(doc);
  return {
    doc: {
      ...doc,
      schema: newer ? stored : SHOP_SCHEMA,
      shop: cleanShop(doc.shop),
      categories: (Array.isArray(doc.categories) ? doc.categories : []).map(cleanCategory).filter(Boolean)
    },
    schema: stored,
    newer
  };
}

/** Własna cena: { gp, sp, cp } (liczby całkowite ≥ 0) albo null; pozostałe pola zostają. */
function cleanPrice(raw) {
  if (!isObject(raw)) return null;
  const { pp, ...rest } = raw; // pp: od schematu 1 nieużywane (przeliczane przez migrację)
  const coin = (v) => Math.max(0, Math.floor(Number(v) || 0));
  return { ...rest, gp: coin(rest.gp), sp: coin(rest.sp), cp: coin(rest.cp) };
}

/**
 * Jedyny odczyt flag modułu na przedmiocie.
 * @param {object|undefined} raw  `item.flags[MODULE_ID]`
 * @returns {{ flags: { schema, category, basePrice, … }, schema: number, newer: boolean }}
 */
export function readItemFlags(raw) {
  let flags = isObject(raw) ? raw : {};
  const stored = schemaOf(flags);
  const newer = stored > SHOP_SCHEMA;
  if (!newer) for (let s = stored; s < SHOP_SCHEMA; s += 1) flags = (ITEM_MIGRATIONS[s] ?? ((f) => f))(flags);
  const merged = { ...SHOP_DEFAULTS.item, ...flags };
  return {
    flags: {
      ...merged,
      schema: newer ? stored : SHOP_SCHEMA,
      category: typeof merged.category === "string" && merged.category ? merged.category : null,
      basePrice: cleanPrice(merged.basePrice)
    },
    schema: stored,
    newer
  };
}

/* ---------------- Dostęp przez dokumenty Foundry ---------------- */

/** Odczyt dokumentu sklepu z aktora (patrz `readShopDoc`). */
export function readShop(actor) {
  return readShopDoc(actor?.flags?.[MODULE_ID]);
}

/** Odczyt flag modułu z przedmiotu (patrz `readItemFlags`). */
export function readItem(item) {
  return readItemFlags(item?.flags?.[MODULE_ID]);
}

/** Czy sklep zapisała nowsza wersja modułu (wtedy tylko do odczytu). */
export function isShopReadOnly(actor) {
  return readShop(actor).newer;
}

let warned = false;
/** Komunikat dla MG: dane z nowszej wersji modułu nie zostaną nadpisane (raz na sesję). */
function warnNewer() {
  if (warned) return;
  warned = true;
  const module = game.modules.get(MODULE_ID)?.title ?? MODULE_ID;
  ui.notifications.warn(game.i18n.format("PF2E_SHOP.Data.NewerShop", { module }));
}

/**
 * Jedyny zapis dokumentu sklepu: zapisuje cały dokument w aktualnym schemacie,
 * z podmienionymi częściami z `changes`. Sklepu z nowszej wersji modułu nie nadpisuje.
 * @param {Actor} actor
 * @param {{ shop?: object, categories?: object[] }} changes
 * @returns {Promise<boolean>} czy zapisano
 */
export async function writeShop(actor, changes = {}) {
  const { doc, newer } = readShop(actor);
  if (newer) {
    warnNewer();
    return false;
  }
  const next = readShopDoc({ ...doc, ...changes }).doc;
  await actor.update({
    [`flags.${MODULE_ID}.schema`]: SHOP_SCHEMA,
    [`flags.${MODULE_ID}.shop`]: next.shop,
    [`flags.${MODULE_ID}.categories`]: next.categories
  });
  return true;
}

/**
 * Zmiany flag przedmiotu w aktualnym schemacie, do `item.update` albo
 * `updateEmbeddedDocuments` (ścieżki `flags.<moduł>.…`). null = przedmiot z nowszej
 * wersji modułu (nie nadpisywać).
 */
export function itemFlagsUpdate(item, changes = {}) {
  const { flags, newer } = readItem(item);
  if (newer) return null;
  const next = readItemFlags({ ...flags, ...changes }).flags;
  return {
    [`flags.${MODULE_ID}.schema`]: SHOP_SCHEMA,
    [`flags.${MODULE_ID}.category`]: next.category,
    [`flags.${MODULE_ID}.basePrice`]: next.basePrice
  };
}

/** Jedyny zapis flag modułu na przedmiocie (patrz `itemFlagsUpdate`). */
export async function writeItemFlags(item, changes = {}) {
  const update = itemFlagsUpdate(item, changes);
  if (!update) {
    warnNewer();
    return item;
  }
  return item.update(update);
}

/**
 * Flagi modułu dla nowo tworzonego przedmiotu w sklepie (losowanie, odkup, upuszczenie):
 * flagi źródła (np. własna cena) odczytane i uzupełnione o kategorię, w aktualnym schemacie.
 * @param {object} [sourceFlags]  dotychczasowe `flags[MODULE_ID]` źródła
 */
export function newItemFlags(sourceFlags, categoryId) {
  const { flags } = readItemFlags(sourceFlags);
  return readItemFlags({ ...flags, schema: SHOP_SCHEMA, category: categoryId ?? null }).flags;
}

/* ---------------- Migracja świata ---------------- */

/** Wersja danych świata: rośnie, gdy rośnie którykolwiek schemat (sklep albo listy towaru). */
export const DATA_VERSION = 1;
const VERSION_SETTING = "dataVersion";
/** Klucz ustawienia wersji danych (do kopiowania spod dawnego ID, `moveLegacyData`). */
export const DATA_VERSION_SETTING = VERSION_SETTING;

/** Rejestruje ustawienie wersji danych świata (wywoływane w `init`). */
export function registerDataVersionSetting() {
  game.settings.register(MODULE_ID, VERSION_SETTING, { scope: "world", config: false, type: Number, default: 0 });
  game.settings.register(MODULE_ID, LEGACY_SETTING, { scope: "world", config: false, type: Boolean, default: false });
}

/** Czy aktor jest sklepem albo ma dane sklepu (postacie graczy pomijamy). */
const isShopActor = (actor) => !!actor?.flags?.[MODULE_ID] || (actor?.type === "loot" && actor.system?.lootSheetType === "Merchant");

/** Sklepy do migracji: aktorzy świata i niepołączone tokeny na scenach (dane w delcie tokenu). */
function shopActors() {
  const actors = game.actors.filter(isShopActor);
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      const delta = token.delta?._source;
      const touched = delta?.flags?.[MODULE_ID] || delta?.items?.some?.((i) => i.flags?.[MODULE_ID]);
      if (!token.actorLink && touched && isShopActor(token.actor)) actors.push(token.actor);
    }
  }
  return actors;
}

/**
 * Przenosi jeden sklep do aktualnego schematu. Przed zapisem kopia starych flag aktora
 * i jego przedmiotów trafia do `flags[MODULE_ID].backup`.
 * @returns {Promise<boolean>} czy coś zmieniono
 */
export async function migrateShop(actor) {
  const raw = actor.flags?.[MODULE_ID];
  const shop = readShop(actor);
  const items = actor.items.filter((i) => i.flags?.[MODULE_ID] && readItem(i).schema < SHOP_SCHEMA && !readItem(i).newer);
  const actorOld = !!raw && !shop.newer && shop.schema < SHOP_SCHEMA;
  if (!actorOld && !items.length) return false;

  const { backup, ...old } = raw ?? {};
  const copy = (value) => JSON.parse(JSON.stringify(value ?? null));
  const update = {
    [`flags.${MODULE_ID}.backup`]: {
      date: new Date().toISOString(),
      moduleVersion: game.modules.get(MODULE_ID)?.version ?? null,
      fromSchema: shop.schema,
      toSchema: SHOP_SCHEMA,
      shop: copy(old),
      items: Object.fromEntries(items.map((i) => [i.id, copy(i.flags[MODULE_ID])]))
    }
  };
  if (actorOld) {
    Object.assign(update, {
      [`flags.${MODULE_ID}.schema`]: SHOP_SCHEMA,
      [`flags.${MODULE_ID}.shop`]: shop.doc.shop,
      [`flags.${MODULE_ID}.categories`]: shop.doc.categories
    });
  }
  await actor.update(update);
  const itemUpdates = items.map((i) => ({ _id: i.id, ...itemFlagsUpdate(i) }));
  if (itemUpdates.length) await actor.updateEmbeddedDocuments("Item", itemUpdates);
  return true;
}

/**
 * Przywraca dane sklepu sprzed ostatniej migracji (z `flags[MODULE_ID].backup`).
 * Ręcznie, z konsoli: `game.modules.get("<id modułu>").api.restoreShopBackup(actor)`.
 * @returns {Promise<boolean>} czy była kopia do przywrócenia
 */
export async function restoreShopBackup(actor) {
  const backup = actor?.flags?.[MODULE_ID]?.backup;
  if (!isObject(backup) || !isObject(backup.shop)) return false;
  const old = backup.shop;
  await actor.update({
    [`flags.${MODULE_ID}.schema`]: old.schema ?? 0,
    [`flags.${MODULE_ID}.shop`]: old.shop ?? null,
    [`flags.${MODULE_ID}.categories`]: old.categories ?? null
  });
  const updates = Object.entries(backup.items ?? {})
    .filter(([id]) => actor.items.has(id))
    .map(([id, flags]) => ({ _id: id, [`flags.${MODULE_ID}`]: { ...flags, schema: flags?.schema ?? 0 } }));
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  return true;
}

/**
 * Migracja danych świata przy starcie (hook `ready`, tylko jeden aktywny MG):
 * gdy zapisana wersja danych jest niższa niż `DATA_VERSION`, przenosi wszystkie sklepy
 * i listy towaru do aktualnych schematów (z kopią starych danych) i zapisuje nową wersję.
 * Gdy wyższa — świat zapisała nowsza wersja modułu: tylko ostrzeżenie, bez zapisu.
 * Bez tej migracji dane i tak są czytane poprawnie (migracja przy odczycie); ta tylko
 * utrwala nowy kształt w świecie.
 * @param {() => Promise<number>} migrateLists  migracja list towaru (stock-lists-store.js)
 */
export async function migrateWorld(migrateLists) {
  if (!(game.users.activeGM?.isSelf ?? game.user.isGM)) return;
  const module = game.modules.get(MODULE_ID)?.title ?? MODULE_ID;
  const stored = Number(game.settings.get(MODULE_ID, VERSION_SETTING)) || 0;
  if (stored > DATA_VERSION) {
    ui.notifications.warn(game.i18n.format("PF2E_SHOP.Data.NewerWorld", { module }), { permanent: true });
    return;
  }
  if (stored === DATA_VERSION) return;
  let shops = 0;
  for (const actor of shopActors()) {
    try {
      if (await migrateShop(actor)) shops += 1;
    } catch (error) {
      console.error(`${MODULE_ID} | Migracja sklepu ${actor.name} nie powiodła się`, error);
      ui.notifications.error(game.i18n.format("PF2E_SHOP.Data.MigrationFailed", { module, name: actor.name }), { permanent: true });
      return; // wersja danych zostaje stara — następny start spróbuje ponownie
    }
  }
  const lists = await migrateLists();
  await game.settings.set(MODULE_ID, VERSION_SETTING, DATA_VERSION);
  if (shops || lists) ui.notifications.info(game.i18n.format("PF2E_SHOP.Data.Migrated", { module, shops, lists }));
}

/* ---------------- Dawne ID modułu ---------------- */

/**
 * Dawne ID modułu (do wersji 0.54): obecne ID → ID, spod których przenosimy dane.
 * Wersja robocza bierze dane z dawnej wersji roboczej, wydanie z dawnego wydania.
 */
export const LEGACY_IDS = Object.freeze({ "pw-merchants-dev": ["pw-merchant-dev"], "pw-merchants": ["pw-merchant"] });
/** Ustawienie świata: dane spod dawnego ID zostały już sprawdzone i przeniesione. */
const LEGACY_SETTING = "legacyDataMoved";

/** Surowa wartość ustawienia świata innego modułu (bez rejestracji) albo undefined. */
function rawWorldSetting(id, key) {
  const doc = game.settings.storage.get("world")?.find?.((s) => s.key === `${id}.${key}`);
  if (!doc) return undefined;
  const value = doc.value ?? doc._source?.value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Kopiuje dane świata zapisane pod dawnym ID modułu (`LEGACY_IDS`) pod obecne ID: flagi
 * aktorów, przedmiotów (także w niepołączonych tokenach i w zakładce Przedmioty) oraz
 * podane ustawienia świata. Dane już zapisane pod obecnym ID nie są nadpisywane, a stare
 * zostają na miejscu (kopia, nie przeniesienie). Raz na świat (ustawienie `legacyDataMoved`),
 * tylko jeden aktywny MG; uruchamiane przed `migrateWorld`, która potem przenosi skopiowane
 * dane do aktualnego schematu.
 * @param {string[]} settingKeys  klucze ustawień świata do skopiowania
 * @returns {Promise<{ shops: number, items: number, settings: number } | null>}  null = pominięte
 */
export async function moveLegacyData(settingKeys) {
  if (!(game.users.activeGM?.isSelf ?? game.user.isGM)) return null;
  if (game.settings.get(MODULE_ID, LEGACY_SETTING)) return null;
  const oldIds = LEGACY_IDS[MODULE_ID] ?? [];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const legacyFlags = (flags) => {
    const id = oldIds.find((old) => isObject(flags?.[old]));
    return id ? flags[id] : null;
  };
  const needsMove = (doc) => !!legacyFlags(doc?.flags) && !isObject(doc.flags?.[MODULE_ID]);
  const moved = { shops: 0, items: 0, settings: 0 };

  const moveActor = async (actor) => {
    if (needsMove(actor)) {
      await actor.update({ [`flags.${MODULE_ID}`]: copy(legacyFlags(actor.flags)) });
      moved.shops += 1;
    }
    const items = actor.items.filter(needsMove).map((i) => ({ _id: i.id, [`flags.${MODULE_ID}`]: copy(legacyFlags(i.flags)) }));
    if (items.length) await actor.updateEmbeddedDocuments("Item", items);
    moved.items += items.length;
  };

  for (const actor of game.actors) await moveActor(actor);
  // Niepołączone tokeny: tylko gdy dawne dane są w delcie tokenu (dane aktora bazowego już przeniesione).
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      const delta = token.delta?._source;
      const touched = legacyFlags(delta?.flags) || delta?.items?.some?.((i) => legacyFlags(i.flags));
      if (!token.actorLink && touched && token.actor) await moveActor(token.actor);
    }
  }
  for (const item of game.items ?? []) {
    if (!needsMove(item)) continue;
    await item.update({ [`flags.${MODULE_ID}`]: copy(legacyFlags(item.flags)) });
    moved.items += 1;
  }

  for (const key of settingKeys) {
    if (rawWorldSetting(MODULE_ID, key) !== undefined) continue; // już zapisane pod obecnym ID
    const id = oldIds.find((old) => rawWorldSetting(old, key) !== undefined);
    if (!id) continue;
    await game.settings.set(MODULE_ID, key, copy(rawWorldSetting(id, key)));
    moved.settings += 1;
  }

  await game.settings.set(MODULE_ID, LEGACY_SETTING, true);
  if (moved.shops || moved.items || moved.settings) {
    const module = game.modules.get(MODULE_ID)?.title ?? MODULE_ID;
    ui.notifications.info(game.i18n.format("PF2E_SHOP.Data.LegacyMoved", { module, old: oldIds.join(", ") }), { permanent: true });
  }
  return moved;
}
