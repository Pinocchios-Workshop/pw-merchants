/**
 * Warstwa danych: odczyt i zapis danych sklepu na aktorze oraz wyliczanie cen.
 * Bez UI.
 *
 * Kształt danych, odczyt, zapis i migracje: shop-store.js (jedyne miejsce, które
 * czyta i zapisuje flagi modułu). Tutaj logika sklepu na odczytanych danych.
 *   sklep:      { priceModifier, tags }
 *   kategorie:  [{ id, name, tables: [{ listId | uuid, countMin, countMax }] }]
 *     (źródło towaru: `listId` = lista towaru modułu; `uuid` = starsza tabela losowa Foundry)
 *   przedmiot:  { category: id | null ("Inne"), basePrice: { gp, sp, cp } | null }
 */
import { OTHER_CATEGORY, BUYBACK_CATEGORY, BUYBACK_MODIFIER, RARITY_COLORS } from "./constants.js";
import { readShop, readItem, writeShop, writeItemFlags, itemFlagsUpdate, clampModifier, toCount } from "./shop-store.js";
import { getStockList } from "./stock-lists-store.js";
import { levelChances, partyLevel } from "./stock-draw.js";
import { keyAcceptsLabels } from "./sheets/filters.js";

/* ---------------- Sklep ---------------- */

export { clampModifier, toCount };

/** Ustawienia sklepu (mnożnik cen, tagi), uzupełnione wartościami domyślnymi. */
export function getShopData(actor) {
  return readShop(actor).doc.shop;
}

/** Zapisuje mnożnik cen sklepu (MG). */
export async function setPriceModifier(actor, value) {
  const priceModifier = clampModifier(value);
  const shop = getShopData(actor);
  if (priceModifier === shop.priceModifier) return;
  await writeShop(actor, { shop: { ...shop, priceModifier } });
}

/** Czy aktor jest sklepem (Loot w trybie Merchant). */
export function isMerchantActor(actor) {
  return actor?.type === "loot" && actor.system?.lootSheetType === "Merchant";
}

/* ---------------- Kategorie ---------------- */

/**
 * Kategorie sklepu w zapisanej kolejności: { id, name, tables: [slot] } (+ pola nieznane
 * tej wersji modułu, zachowywane przy zapisie). Starsze kształty przenosi shop-store.js.
 */
export function getCategories(actor) {
  return readShop(actor).doc.categories;
}

/** Zakres jako tekst: „3” albo „2–4”. */
export function rangeText(min, max) {
  return min === max ? `${max}` : `${min}–${max}`;
}

/** Łączny zakres liczby przedmiotów kategorii (suma zakresów jej tabel). */
export function categoryRange(category) {
  const tables = category?.tables ?? [];
  return {
    min: tables.reduce((sum, t) => sum + t.countMin, 0),
    max: tables.reduce((sum, t) => sum + t.countMax, 0)
  };
}

/**
 * Sprawdza zakres „od–do”. Zwraca { min, max } albo { error } z kluczem komunikatu.
 */
export function validateCountRange(min, max) {
  const a = toCount(min);
  const b = toCount(max);
  if (a === null || b === null) return { error: "PF2E_SHOP.CategoryConfig.CountInvalid" };
  if (a > b) return { error: "PF2E_SHOP.CategoryConfig.CountOrder" };
  return { min: a, max: b };
}

/** Losowa liczba całkowita z zakresu [min, max] (włącznie). */
export function rollCount(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Zapisuje całą listę kategorii (przez shop-store.js, w aktualnym schemacie). */
async function saveCategories(actor, categories) {
  return writeShop(actor, { categories });
}

/**
 * Tworzy nową kategorię albo nadpisuje istniejącą o tym samym id.
 * @returns {Promise<string>} id kategorii
 */
export async function upsertCategory(actor, { id = null, name, tables = [] }) {
  const clean = [];
  for (const table of tables) {
    if (!table?.listId && !table?.uuid) continue;
    const range = validateCountRange(table.countMin, table.countMax);
    if (range.error) throw new Error(range.error);
    // Pola slotu nieznane tej wersji modułu zostają (`...rest`).
    const { listId, uuid, ...rest } = table;
    const source = listId ? { listId } : { uuid };
    clean.push({ ...rest, ...source, countMin: range.min, countMax: range.max });
  }
  const categories = getCategories(actor);
  const existing = id ? categories.find((c) => c.id === id) : null;
  const data = {
    ...(existing ?? {}),
    id: id ?? foundry.utils.randomID(),
    name: String(name).trim(),
    tables: clean
  };
  const index = categories.findIndex((c) => c.id === data.id);
  if (index >= 0) categories[index] = data;
  else categories.push(data);
  await saveCategories(actor, categories);
  return data.id;
}

/**
 * Przenosi kategorię przed albo za inną kategorię.
 * `targetId` równy null (np. upuszczenie na "Inne") = na koniec listy.
 * @param {"before"|"after"} place
 * @returns {Promise<boolean>} czy kolejność się zmieniła
 */
export async function moveCategory(actor, categoryId, targetId, place = "before") {
  const categories = getCategories(actor);
  const from = categories.findIndex((c) => c.id === categoryId);
  if (from < 0 || categoryId === targetId) return false;
  const before = categories.map((c) => c.id).join();

  const [moved] = categories.splice(from, 1);
  let to = targetId ? categories.findIndex((c) => c.id === targetId) : -1;
  if (to < 0) to = categories.length;
  else if (place === "after") to += 1;
  categories.splice(to, 0, moved);

  if (categories.map((c) => c.id).join() === before) return false;
  await saveCategories(actor, categories);
  return true;
}

/** Przesuwa kategorię o `delta` miejsc (np. -1 = wyżej). */
export async function shiftCategory(actor, categoryId, delta) {
  const categories = getCategories(actor);
  const from = categories.findIndex((c) => c.id === categoryId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= categories.length) return false;
  const [moved] = categories.splice(from, 1);
  categories.splice(to, 0, moved);
  await saveCategories(actor, categories);
  return true;
}

/** Usuwa kategorię; jej przedmioty wracają do "Inne". */
export async function deleteCategory(actor, categoryId) {
  const categories = getCategories(actor).filter((c) => c.id !== categoryId);
  if (!(await saveCategories(actor, categories))) return;
  const updates = actor.items
    .filter((item) => getItemCategory(item) === categoryId)
    .map((item) => ({ _id: item.id, ...itemFlagsUpdate(item, { category: null }) }))
    .filter((u) => Object.keys(u).length > 1);
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

/**
 * Towar danej kategorii, tak jak pokazuje go karta: dla "Inne" to przedmioty
 * bez kategorii albo z kategorią, która już nie istnieje.
 */
export function getCategoryItems(actor, categoryId) {
  const known = new Set(getCategories(actor).map((c) => c.id));
  return getWares(actor).filter((item) => {
    const id = getItemCategory(item);
    if (categoryId === OTHER_CATEGORY) return !id || (!known.has(id) && id !== BUYBACK_CATEGORY);
    return id === categoryId;
  });
}

/**
 * Trwale usuwa wszystkie przedmioty z kategorii. Sama kategoria zostaje.
 * @returns {Promise<number>} liczba usuniętych pozycji
 */
export async function clearCategoryItems(actor, categoryId) {
  const ids = getCategoryItems(actor, categoryId).map((item) => item.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  return ids.length;
}

/**
 * Identyfikator oryginału przedmiotu: UUID wpisu w kompendium albo w świecie,
 * z którego przedmiot skopiowano (to samo co `sourceId` w PF2e). Null, gdy brak.
 */
export function getItemOrigin(item) {
  const stats = item?._source?._stats ?? item?._stats ?? {};
  return stats.duplicateSource ?? stats.compendiumSource ?? item?.flags?.core?.sourceId ?? null;
}

/**
 * Typ amunicji przedmiotu (`system.baseItem`) albo null.
 * Czytamy najpierw dane źródłowe: przy amunicji specjalnej PF2e wpisuje wybrany typ
 * tylko do `_source` tworzonego przedmiotu, a `system` zostaje jeszcze bez typu.
 */
function ammoBaseItem(item) {
  if (item?.type !== "ammo") return null;
  return item._source?.system?.baseItem ?? item.system?.baseItem ?? null;
}

/**
 * Klucz "tego samego przedmiotu": oryginał + typ amunicji.
 * Dwa przedmioty z tego samego wpisu w kompendium, ale z innym typem amunicji
 * (np. Beacon Shot jako strzały i jako bełty) mają różne klucze.
 */
export function getStackKey(item) {
  const origin = getItemOrigin(item);
  return origin ? `${origin}|${ammoBaseItem(item) ?? ""}` : null;
}

/**
 * Szuka w kategorii przedmiotu, z którym można połączyć nowy przedmiot.
 * Warunki: ten sam oryginał (UUID, nie nazwa), ten sam typ, ten sam typ amunicji
 * i zgoda PF2e (`isStackableWith`: identyfikacja, materiał, runy i reszta danych).
 * @param {Actor} actor
 * @param {Item} newItem         przedmiot, który właśnie ma powstać
 * @param {string|null} categoryId  kategoria docelowa; null albo "other" = "Inne"
 * @returns {Item|null}
 */
export function findStackTarget(actor, newItem, categoryId) {
  const key = getStackKey(newItem);
  if (!key) return null;
  const candidates = getCategoryItems(actor, categoryId ?? OTHER_CATEGORY);
  return (
    candidates.find((existing) => {
      if (existing === newItem || existing.type !== newItem.type) return false;
      if (getStackKey(existing) !== key) return false;
      try {
        return typeof existing.isStackableWith === "function" ? existing.isStackableWith(newItem) : true;
      } catch {
        // Gdy PF2e nie umie porównać (np. przedmiot jeszcze nieprzygotowany), wystarczy klucz.
        return existing.name === newItem.name;
      }
    }) ?? null
  );
}

/** Id kategorii przedmiotu albo null. */
export function getItemCategory(item) {
  return readItem(item).flags.category;
}

/** Czy przedmiot leży w „Odkupie”. */
export function isBuyback(item) {
  return getItemCategory(item) === BUYBACK_CATEGORY;
}

/**
 * Mnożnik ceny konkretnego przedmiotu w sklepie: w „Odkupie” zawsze 75%
 * (bez mnożnika sklepu), w pozostałych kategoriach mnożnik sklepu.
 */
export function itemModifier(actor, item) {
  return isBuyback(item) ? BUYBACK_MODIFIER : getShopData(actor).priceModifier;
}

/** Przypisuje przedmiot do kategorii ("other" albo null = brak kategorii). */
export async function setItemCategory(item, categoryId) {
  const value = !categoryId || categoryId === OTHER_CATEGORY ? null : categoryId;
  if (getItemCategory(item) === value) return item;
  return writeItemFlags(item, { category: value });
}

/* ---------------- Tabele losowe ---------------- */

/** Usuwa znaczniki HTML z tekstu. */
function stripHTML(html) {
  return String(html ?? "").replace(/<[^>]*>/g, "").trim();
}

/**
 * Podsumowanie tabeli losowej do wyświetlenia: nazwa i pozycje z wagami.
 * @returns {Promise<object|null>} null, gdy tabela nie istnieje
 */
export async function getTableSummary(uuid) {
  if (!uuid) return null;
  const table = await fromUuid(uuid).catch(() => null);
  if (!table || table.documentName !== "RollTable") return null;

  const results = [...table.results];
  const totalWeight = results.reduce((sum, r) => sum + Math.max(0, Number(r.weight) || 0), 0);
  const entries = results
    .map((r) => {
      const weight = Math.max(0, Number(r.weight) || 0);
      const isDocument = r.type === "document" || r.type === "pack" || !!r.documentUuid;
      return {
        name: r.name || stripHTML(r.description) || stripHTML(r.text) || "—",
        img: r.img || null,
        weight,
        level: "—", // starsza tabela losowa nie zna poziomu pozycji
        chance: totalWeight ? `${Math.round((weight / totalWeight) * 1000) / 10}%` : "—",
        isDocument
      };
    })
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name, game.i18n.lang));
  entries.forEach((e, i) => (e.odd = i % 2 === 1));

  return { uuid, name: table.name, entries, totalWeight, size: entries.length };
}

/**
 * Nazwa źródła towaru w slocie kategorii: lista towaru (`listId`) albo starsza tabela
 * losowa (`uuid`); null, gdy źródło już nie istnieje. Jedno miejsce dla karty sklepu,
 * okna losowania i ustawień kategorii.
 */
export function getSourceName(slot) {
  if (slot?.listId) return getStockList(slot.listId)?.name ?? null;
  return getTableName(slot?.uuid);
}

/**
 * Podsumowanie listy towaru do podglądu w ustawieniach kategorii — ten sam kształt
 * co `getTableSummary`: { listId, name, entries: [{ name, img, weight, chance, isDocument, tag }], size }.
 * Przedmioty gwarantowane są na końcu, z tagiem i zakresem ilości zamiast szansy.
 */
export function getListSummary(listId) {
  const list = listId ? getStockList(listId) : null;
  if (!list) return null;
  // Szanse jak w losowaniu: ręczne wagi albo funkcja wykładnicza dla obecnego poziomu drużyny.
  const levelMode = list.mode === "partyLevel";
  const total = list.entries.reduce((sum, e) => sum + e.weight, 0);
  const chances = levelMode ? levelChances(list.entries, partyLevel() ?? NaN) : list.entries.map((e) => (total ? e.weight / total : 0));
  const entries = list.entries
    .map((e, i) => ({
      name: e.name,
      img: e.img,
      // Podgląd w ustawieniach kategorii pokazuje poziom przedmiotu (zamiast wagi) i szansę.
      level: e.level ?? 0,
      p: chances[i],
      chance: `${Math.round(chances[i] * 1000) / 10}%`,
      isDocument: true
    }))
    .sort((a, b) => b.p - a.p || a.name.localeCompare(b.name, game.i18n.lang));
  const guaranteed = (list.guaranteed ? list.guaranteedEntries : []).map((e) => ({
    name: e.name,
    img: e.img,
    level: e.level ?? 0,
    chance: rangeText(e.min, e.max),
    isDocument: true,
    tag: game.i18n.localize("PF2E_SHOP.StockLists.GuaranteedTag")
  }));
  const all = [...entries, ...guaranteed];
  all.forEach((e, i) => (e.odd = i % 2 === 1));
  // Liczba przedmiotów na liście (losowane + gwarantowane), pokazywana przy nazwie listy w podglądzie.
  return { listId, name: list.name, entries: all, size: all.length, mode: list.mode };
}

/** Nazwa tabeli bez ładowania pełnego dokumentu (dla nagłówków kategorii). */
export function getTableName(uuid) {
  if (!uuid) return null;
  return fromUuidSync(uuid, { strict: false })?.name ?? null;
}

/* ---------------- Ceny i towar ---------------- */

/** Wartości nominałów w miedziakach. */
const DENOMINATIONS = [["pp", 1000], ["gp", 100], ["sp", 10], ["cp", 1]];

/**
 * Najmniejszy nominał użyty w cenie (w miedziakach): do niego zaokrąglamy cenę
 * po mnożniku. „4 gp” -> 100, „1 gp 5 sp” -> 10, „3 cp” -> 1.
 */
export function roundingUnit(coins) {
  let unit = 1;
  for (const [denomination, rate] of DENOMINATIONS) {
    if (Number(coins?.[denomination]) > 0) unit = rate;
  }
  return unit;
}

/** Nazwa najmniejszego użytego nominału („sp” dla „12 sp”) albo null dla zera. */
export function unitDenomination(coins) {
  let unit = null;
  for (const [denomination] of DENOMINATIONS) {
    if (Number(coins?.[denomination]) > 0) unit = denomination;
  }
  return unit;
}

/**
 * Kwota w miedziakach zapisana w jednym nominale, bez zamiany na wyższe monety:
 * 140 cp w „sp” -> { sp: 14 }. Używane dla własnej ceny (jedna waluta).
 */
export function coinsIn(copper, denomination) {
  const unit = denomination ?? "gp";
  const rate = Object.fromEntries(DENOMINATIONS)[unit];
  return { [unit]: Math.round(copper / rate) };
}

/** Zapis kwoty w jednym nominale, np. „14 sp”. */
export function formatIn(copper, denomination) {
  const [[unit, value]] = Object.entries(coinsIn(copper, denomination));
  return `${value} ${unit}`;
}

/**
 * Cena paczki (tyle sztuk, ile `per`, zwykle 1) w miedziakach po mnożniku.
 * Wynik jest zaokrąglany w górę do pełnej liczby najmniejszego nominału ceny:
 * 4 gp × 110% = 4,4 gp -> 5 gp; 1 sp (10 strzał) × 150% -> 2 sp.
 */
export function modifiedPackCopper(price, modifier = 1) {
  const base = price?.value?.copperValue ?? 0;
  const percent = Math.round(clampModifier(modifier) * 100);
  if (percent === 100 || base <= 0) return base;
  const unit = roundingUnit(price.value);
  // Liczymy na liczbach całkowitych (procentach), żeby uniknąć błędów zaokrągleń.
  return Math.max(0, Math.ceil((base * percent) / (100 * unit) - 1e-9)) * unit;
}

/** Kwota { pp, gp, sp, cp } z polem `copperValue`, jak Coins z PF2e. */
export function makeCoins(data = {}) {
  const coins = {};
  for (const [denomination] of DENOMINATIONS) {
    coins[denomination] = Math.max(0, Math.floor(Number(data?.[denomination]) || 0));
  }
  coins.copperValue = DENOMINATIONS.reduce((sum, [d, rate]) => sum + coins[d] * rate, 0);
  return coins;
}

/** Cena z podręcznika (dane przedmiotu PF2e, bez mnożnika i bez własnej ceny). */
export function bookPrice(item) {
  return item?.system?.price ?? item?.price ?? null;
}

/** Własna cena bazowa ustawiona przez MG albo null. */
export function getCustomPrice(item) {
  const price = readItem(item).flags.basePrice;
  return price ? makeCoins(price) : null;
}

/**
 * Zapisuje własną cenę bazową (null = powrót do ceny z podręcznika). Cena w gp/sp/cp:
 * platyna jest przeliczana na złoto (1 pp = 10 gp).
 */
export async function setCustomPrice(item, coins) {
  if (!coins) return writeItemFlags(item, { basePrice: null });
  const { pp, gp, sp, cp } = makeCoins(coins);
  return writeItemFlags(item, { basePrice: { gp: gp + pp * 10, sp, cp } });
}

/**
 * Cena bazowa w sklepie (przed mnożnikiem): własna cena MG, a jeśli jej nie ma,
 * cena z podręcznika. `per` (np. 10 strzał) zawsze z danych przedmiotu.
 */
export function basePrice(item) {
  const book = bookPrice(item);
  const custom = getCustomPrice(item);
  if (!custom) return book;
  return { ...(book ?? {}), value: custom, per: Math.max(1, book?.per ?? 1) };
}

/**
 * Cena w miedziakach za `quantity` sztuk, z mnożnikiem.
 * PF2e trzyma cenę jako Coins + pole `per` (np. 10 strzał za 1 sp).
 */
export function priceCopper(item, quantity = 1, modifier = 1) {
  const price = basePrice(item);
  const per = Math.max(1, price?.per ?? 1);
  return (modifiedPackCopper(price, modifier) * quantity) / per;
}

/** Cena do wyświetlenia: paczka po mnożniku, np. „5 gp” albo „2 sp / 10”. */
export function formatPrice(item, modifier = 1) {
  const price = basePrice(item);
  const per = Math.max(1, price?.per ?? 1);
  const copper = modifiedPackCopper(price, modifier);
  // Własna cena zostaje w swojej walucie („14 sp”), cena z podręcznika jak w PF2e.
  const custom = getCustomPrice(item);
  const text = custom ? formatIn(copper, unitDenomination(custom)) : formatCopper(copper);
  return per > 1 ? `${text} / ${per}` : text;
}

/** Czytelny zapis kwoty, np. "12 gp 5 sp". */
export function formatCopper(copper) {
  let rest = Math.max(0, Math.floor(copper));
  const gp = Math.floor(rest / 100);
  rest %= 100;
  const sp = Math.floor(rest / 10);
  const cp = rest % 10;
  const parts = [];
  if (gp) parts.push(`${gp} gp`);
  if (sp) parts.push(`${sp} sp`);
  if (cp) parts.push(`${cp} cp`);
  return parts.length ? parts.join(" ") : "0 cp";
}

/** Stan kasy sklepu jako lista nominałów do wyświetlenia. */
export function getPurse(actor) {
  return Object.entries(normalizePurse(purseCopper(actor))).map(([denomination, value]) => ({ denomination, value }));
}

/** Nominały kasy sklepu: bez platyny, złoto jest najwyższą monetą. */
export const PURSE_DENOMINATIONS = ["gp", "sp", "cp"];

/** Wartość kasy w miedziakach (wszystkie monety sklepu, także ewentualne pp). */
export function purseCopper(actor) {
  const coins = actor?.inventory?.currency ?? actor?.inventory?.coins ?? {};
  if (Number.isFinite(coins.copperValue)) return coins.copperValue;
  return makeCoins(coins).copperValue;
}

/**
 * Kwota rozłożona na gp/sp/cp tak, żeby niższy nominał nie przekraczał 9:
 * 1234 cp -> 12 gp 3 sp 4 cp. Platyna nie jest używana.
 */
export function normalizePurse(copper) {
  let rest = Math.max(0, Math.floor(Number(copper) || 0));
  const gp = Math.floor(rest / 100);
  rest %= 100;
  return { gp, sp: Math.floor(rest / 10), cp: rest % 10 };
}

/**
 * Ustawia kasę sklepu na podaną wartość, zawsze rozłożoną na gp/sp/cp
 * (np. wpisane 25 sp zostaje zapisane jako 2 gp 5 sp, platyna jest zamieniana
 * na złoto). Różnice dodaje i odejmuje funkcjami PF2e, więc monety zostają
 * zwykłymi przedmiotami-monetami w ekwipunku.
 * @param {object|number} target  kwota { pp, gp, sp, cp } albo wartość w cp
 */
export async function setPurse(actor, target) {
  const inventory = actor?.inventory;
  if (!inventory) return;
  const copper = typeof target === "number" ? target : makeCoins(target).copperValue;
  const wanted = { pp: 0, ...normalizePurse(copper) };
  const current = inventory.currency ?? inventory.coins ?? {};
  const add = {};
  const remove = {};
  for (const [denomination] of DENOMINATIONS) {
    const diff = (wanted[denomination] ?? 0) - (current[denomination] ?? 0);
    if (diff > 0) add[denomination] = diff;
    else if (diff < 0) remove[denomination] = -diff;
  }
  if (Object.keys(remove).length) {
    const removeFn = inventory.removeCurrency ?? inventory.removeCoins;
    await removeFn.call(inventory, remove, { byValue: false });
  }
  if (Object.keys(add).length) {
    const addFn = inventory.addCurrency ?? inventory.addCoins;
    await addFn.call(inventory, add);
  }
}

/* ---------------- Tagi sklepu ---------------- */

/** Własne tagi sklepu (kosmetyczne). */
export function getShopTags(actor) {
  const tags = getShopData(actor).tags;
  return Array.isArray(tags) ? tags.filter((t) => typeof t === "string" && t.trim()) : [];
}

async function saveShopTags(actor, tags) {
  await writeShop(actor, { shop: { ...getShopData(actor), tags } });
}

/** Dodaje tag (bez duplikatów, wielkość liter bez znaczenia). */
export async function addShopTag(actor, name) {
  const tag = String(name ?? "").trim().slice(0, 40);
  if (!tag) return;
  const tags = getShopTags(actor);
  if (tags.some((t) => t.toLocaleLowerCase() === tag.toLocaleLowerCase())) return;
  await saveShopTags(actor, [...tags, tag]);
}

export async function removeShopTag(actor, index) {
  const tags = getShopTags(actor);
  if (!(index >= 0 && index < tags.length)) return;
  tags.splice(index, 1);
  await saveShopTags(actor, tags);
}

/** Czy przedmiot nadaje się na towar: fizyczny i nie jest monetami. */
export function isSellable(item) {
  return !!item?.isOfType?.("physical") && !item.isCoinage;
}

/** Towar: przedmioty fizyczne sklepu bez monet. */
export function getWares(actor) {
  return actor?.inventory?.contents.filter((item) => !item.isCoinage) ?? [];
}

/**
 * Bulk jednej sztuki w zapisie PF2e: "—", "L", "2L", "1", "1; 2L".
 * Przy przedmiotach liczonych paczkami (np. 10 strzał = L) dopisuje "/ 10".
 */
export function formatUnitBulk(item) {
  const bulk = item?.system?.bulk ?? {};
  const value = Math.max(0, Number(bulk.value) || 0);
  const per = Math.max(1, Number(bulk.per) || 1);
  const i18n = game.i18n;
  let label;
  if (value === 0) {
    label = i18n.localize("PF2E.Item.Physical.Bulk.Negligible.ShortLabel");
  } else {
    const normal = Math.floor(value + 1e-9);
    const light = Math.round((value - normal) * 10);
    if (light === 0) label = String(normal);
    else if (normal === 0 && light === 1) label = i18n.localize("PF2E.Item.Physical.Bulk.Light.ShortLabel");
    else if (normal === 0) label = i18n.format("PF2E.Item.Physical.Bulk.NLight", { light });
    else label = i18n.format("PF2E.Item.Physical.Bulk.WithLight", { bulk: normal, light });
  }
  return per > 1 && value > 0 ? `${label} / ${per}` : label;
}

/**
 * Typ amunicji do pokazania w rozwinięciu przedmiotu, albo null dla innych przedmiotów.
 * Zwykła amunicja ma jeden typ (`baseItem`); amunicja specjalna bez wybranego typu
 * ma listę typów, jako które może występować (`craftableAs`; pusta lista = każdy).
 */
export function getAmmoTypeLabel(item) {
  if (!item?.isOfType?.("ammo")) return null;
  const types = CONFIG.PF2E?.ammoTypes ?? {};
  const label = (slug) => game.i18n.localize(types[slug]?.label ?? slug);
  const { baseItem, craftableAs } = item.system ?? {};
  if (baseItem) return label(baseItem);
  if (Array.isArray(craftableAs)) {
    return craftableAs.length
      ? craftableAs.map(label).join(", ")
      : game.i18n.localize("PF2E_SHOP.Inventory.AmmoAny");
  }
  return null;
}

/**
 * Na co nakłada się runę („Usage” z karty przedmiotu PF2e), np. „Etched onto a Melee Weapon”.
 * Tylko runy (użycie „etched-onto-…”); dla innych przedmiotów null.
 */
export function getRuneUsageLabel(item) {
  const usage = item?.system?.usage?.value;
  if (typeof usage !== "string" || !usage.startsWith("etched-onto")) return null;
  const key = CONFIG.PF2E?.usages?.[usage];
  return key ? game.i18n.localize(key) : usage;
}

/**
 * Rzadkość przedmiotu do wyświetlenia (kolor paska i tagu, etykieta) — jedna funkcja
 * dla wierszy sklepu, okien sprzedaży i przeglądarki list towaru.
 * @param {string} rarity  „common”, „uncommon”, „rare”, „unique”
 */
export function rarityInfo(rarity = "common") {
  const key = rarity || "common";
  return {
    rarity: key,
    rarityColor: RARITY_COLORS[key] ?? null,
    rarityLabel: game.i18n.localize(CONFIG.PF2E?.rarityTraits?.[key] ?? key),
    showRarity: key !== "common"
  };
}

/** Monety jako tekst „1 pp · 12 gp · 5 sp” (kasa postaci w oknach sprzedaży). */
export function coinsText(coins = {}) {
  return ["pp", "gp", "sp", "cp"].filter((d) => coins?.[d]).map((d) => `${coins[d]} ${d}`).join(" · ") || "0 gp";
}

/** Słowniki cech PF2e, w których szukamy etykiety cechy (najpierw słownik typu przedmiotu). */
const TRAIT_DICTS = {
  weapon: "weaponTraits", armor: "armorTraits", shield: "shieldTraits",
  consumable: "consumableTraits", ammo: "consumableTraits", spell: "spellTraits"
};
const FALLBACK_DICTS = ["equipmentTraits", "consumableTraits", "weaponTraits", "armorTraits", "shieldTraits"];

/**
 * Nazwy typów przedmiotów PF2e w wyszukiwaniu `type:x` (typ wybierany przy tworzeniu
 * przedmiotu). Typy spoza listy szukane pod nazwą systemową.
 */
export const SEARCH_TYPES = Object.freeze({
  ammo: "ammunition", armor: "armor", consumable: "consumable", backpack: "container",
  equipment: "equipment", kit: "kit", shield: "shield", treasure: "treasure", weapon: "weapon"
});

/**
 * Pola szczegółów przedmiotu w wyszukiwaniu: typ przedmiotu → [znacznik, pole `system`,
 * słownik `CONFIG.PF2E` z dozwolonymi wartościami i etykietami]. Opcje i etykiety bierzemy
 * z systemu PF2e w trakcie działania, więc nowe wartości systemu działają same.
 */
const DETAIL_FIELDS = Object.freeze({
  weapon: [
    ["weapon-category", "category", "weaponCategories"],
    ["weapon-group", "group", "weaponGroups"],
    ["weapon-base", "baseItem", "baseWeaponTypes"]
  ],
  armor: [
    ["armor-category", "category", "armorCategories"],
    ["armor-group", "group", "armorGroups"],
    ["armor-base", "baseItem", "baseArmorTypes"]
  ],
  shield: [["shield-base", "baseItem", "baseShieldTypes"]],
  consumable: [["consumable-category", "category", "consumableCategories"]]
});

/** Etykieta wartości ze słownika PF2e (tekst albo `{ label }`) w języku gry, albo null. */
function configLabel(dict, slug) {
  const entry = dict?.[slug];
  const key = typeof entry === "string" ? entry : entry?.label;
  return key ? game.i18n.localize(key) : null;
}

/**
 * Dodaje znacznik pod nazwą systemową i — gdy klucz to przyjmuje (`keyAcceptsLabels`) — pod
 * etykietą w języku gry.
 */
function addSearchTag(tags, key, slug, dict) {
  if (typeof slug !== "string" || !slug) return;
  tags.add(`${key}:${slug}`);
  if (!keyAcceptsLabels(key)) return;
  const label = configLabel(dict, slug);
  if (label) tags.add(`${key}:${label}`);
}

/**
 * Znaczniki przedmiotu do wyszukiwania (filters.js, `parseSearch`; pełny opis w SEARCH.md):
 * `trait:x`, `rarity:x`, `type:x`, `ammunition-type:x`, `armor-category:x`,
 * `consumable-category:x`, `weapon-category:x`, `weapon-group:x`, `weapon-base:x`, `weapon-range:x`,
 * `armor-group:x`, `armor-base:x`, `armor-class:x`, `shield-class:x`, `shield-base:x`, `spell-tradition:x`.
 * @returns {string[]}  np. ["trait:magical", "trait:Magical", "rarity:rare", "type:weapon", "weapon-group:sword"]
 */
export function getItemSearchTags(item) {
  const system = item?.system ?? {};
  // Typ amunicji specjalnej PF2e wpisuje najpierw tylko do `_source` (patrz `ammoBaseItem`).
  const baseItem = item?.type === "ammo" ? ammoBaseItem(item) : system.baseItem;
  const data = {
    traits: system.traits, category: system.category, group: system.group, baseItem, craftableAs: system.craftableAs,
    range: system.range, maxRange: system.maxRange, acBonus: system.acBonus
  };
  return getSearchTags(item?.type, data, item?.rarity ?? system.traits?.rarity);
}

/**
 * Znaczniki wyszukiwania z samych danych — także dla wpisów indeksu kompendium.
 * @param {string} type     typ przedmiotu PF2e
 * @param {object} system   `system` przedmiotu (cechy, kategoria, grupa, typ amunicji)
 * @param {string} [rarity]
 */
export function getSearchTags(type, system = {}, rarity = system?.traits?.rarity ?? "common") {
  const rarities = ["common", "uncommon", "rare", "unique"];
  const config = CONFIG.PF2E ?? {};
  const dicts = [TRAIT_DICTS[type], ...FALLBACK_DICTS].filter(Boolean).map((k) => config[k] ?? {});
  const tags = new Set();
  const traits = system?.traits?.value;
  for (const slug of Array.isArray(traits) ? traits : []) {
    // Rzadkość nie jest cechą w wyszukiwaniu — ma własne `rarity:x`.
    if (typeof slug !== "string" || !slug || rarities.includes(slug)) continue;
    tags.add(`trait:${slug}`);
    const key = dicts.find((dict) => dict[slug])?.[slug];
    if (key) tags.add(`trait:${game.i18n.localize(key)}`);
  }
  tags.add(`rarity:${rarities.includes(rarity) ? rarity : "common"}`);
  if (type) tags.add(`type:${SEARCH_TYPES[type] ?? type}`);
  for (const [key, field, dict] of DETAIL_FIELDS[type] ?? []) addSearchTag(tags, key, system?.[field], config[dict]);
  if (type === "weapon") tags.add(`weapon-range:${weaponRange(system)}`);
  // Premia do AC (zbroja, tarcza): liczba z karty przedmiotu.
  const acBonus = Number(system?.acBonus);
  if (type === "armor" && Number.isInteger(acBonus) && acBonus >= 0) tags.add(`armor-class:${acBonus}`);
  if (type === "shield" && Number.isInteger(acBonus) && acBonus >= 0) tags.add(`shield-class:${acBonus}`);
  // Tradycje zaklęcia (lista, na której jest) — nie mylić z cechą przedmiotu `trait:arcane`.
  if (type === "spell") {
    const traditions = system?.traits?.traditions;
    for (const t of Array.isArray(traditions) ? traditions : []) if (typeof t === "string" && t) tags.add(`spell-tradition:${t}`);
  }
  if (type === "ammo") {
    // Typ amunicji: wybrany (`baseItem`), a gdy go nie ma — typy, jako które może występować
    // amunicja specjalna (`craftableAs`); razem z typem nadrzędnym (np. „rounds” dla „rounds-arquebus”).
    const ammoTypes = config.ammoTypes ?? {};
    const slugs = system?.baseItem ? [system.baseItem] : Array.isArray(system?.craftableAs) ? system.craftableAs : [];
    for (const slug of slugs) {
      addSearchTag(tags, "ammunition-type", slug, ammoTypes);
      addSearchTag(tags, "ammunition-type", ammoTypes[slug]?.parent, ammoTypes);
    }
  }
  return [...tags];
}

/**
 * Zasięg broni w wyszukiwaniu `weapon-range:x`: przyrost zasięgu w stopach (np. „60”), a gdy
 * go nie ma — zasięg maksymalny; broń bez zasięgu to „melee” (jak `isMelee` w PF2e). Broń biała
 * z cechą „thrown” też jest „melee” (rzut opisuje cecha, np. `trait:thrown-10`).
 */
export function weaponRange(system = {}) {
  const range = Number(system?.range) || Number(system?.maxRange) || 0;
  return range > 0 ? String(range) : "melee";
}

/** Dane jednego wiersza listy towaru. */
export function prepareWareRow(item, modifier) {
  const rarity = item.rarity ?? "common";
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    level: item.level ?? 0,
    quantity: item.quantity ?? 1,
    soldOut: (item.quantity ?? 1) <= 0,
    bulk: formatUnitBulk(item),
    tags: getItemSearchTags(item).join("|"),
    ...rarityInfo(rarity),
    price: formatPrice(item, modifier),
    priceCp: priceCopper(item, 1, modifier),
    basePrice: formatPrice(item, 1),
    customPrice: !!getCustomPrice(item),
    bookPrice: formatPrice({ price: bookPrice(item) }, 1)
  };
}
