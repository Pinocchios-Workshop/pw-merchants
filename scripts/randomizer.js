/**
 * Losowanie asortymentu sklepu.
 *
 * Dla każdej kategorii z podpiętą tabelą losową i liczbą > 0 losujemy tyle
 * razy, ile ustawiono. Każde losowanie jest osobne i niezależne (ze zwracaniem):
 * za każdym razem wszystkie pozycje tabeli biorą udział z pełnymi wagami, więc
 * ten sam przedmiot może wypaść kilka razy, a wtedy jego ilość się sumuje.
 * Losujemy sami, a nie przez `table.draw()`, żeby nie zmieniać stanu tabeli
 * (Foundry oznacza wylosowane pozycje w tabelach "bez zwracania").
 *
 * Pozycje tabeli:
 *   - przedmiot fizyczny     → trafia do sklepu,
 *   - inna tabela losowa     → losujemy z niej jedną pozycję (do 5 poziomów w głąb),
 *   - tekst / inny dokument  → "pusty los": zajmuje miejsce, nic nie dodaje.
 * Dzięki temu pozycja tekstowa, np. "Brak towaru", działa jako szansa na mniej towaru.
 *
 * Slot kategorii z listą towaru modułu (`listId`) losuje przez `stock-draw.js`
 * (ręczne wagi albo według poziomu drużyny, limit wylosowań, przedmioty gwarantowane).
 */
import { MODULE_ID } from "./constants.js";
import { newItemFlags } from "./shop-store.js";
import { getCategories, getItemCategory, isSellable, getStackKey, validateCountRange, rollCount } from "./shop-data.js";
import { getStockList } from "./stock-lists-store.js";
import { drawFromList, partyLevel } from "./stock-draw.js";
import { spellConsumableSource, spellFormOf } from "./spell-consumables.js";

const MAX_DEPTH = 5;

/** Liczba losowa z [0, 1): generator Foundry, gdy jest dostępny. */
function random() {
  return CONFIG.Dice?.randomUniform?.() ?? Math.random();
}

/** Wybiera indeks z listy wag. Same zera = każdy tak samo prawdopodobny. */
function pickWeightedIndex(weights) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return Math.floor(random() * weights.length);
  let roll = random() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

/** Zamienia pozycję tabeli na przedmiot fizyczny albo null (pusty los). */
async function resolveResult(result, depth) {
  const uuid = result.documentUuid;
  if (!uuid) return null;
  const doc = await fromUuid(uuid).catch(() => null);
  if (!doc) return null;
  if (doc.documentName === "RollTable") {
    if (depth >= MAX_DEPTH) return null;
    const [nested] = await drawFromTable(doc, 1, depth + 1);
    return nested ?? null;
  }
  return isSellable(doc) ? doc : null;
}

/**
 * Losuje z tabeli `count` razy, po kolei. Każde losowanie jest niezależne:
 * wylosowana pozycja wraca do puli, więc może wypaść ponownie.
 * @returns {Promise<Item[]>} wylosowane przedmioty, z powtórzeniami (puste losy pominięte)
 */
export async function drawFromTable(table, count, depth = 0) {
  const results = [...table.results];
  if (!results.length) return [];
  const weights = results.map((r) => Math.max(0, Number(r.weight) || 0));
  const items = [];
  for (let n = 0; n < count; n++) {
    const result = results[pickWeightedIndex(weights)];
    const item = await resolveResult(result, depth);
    if (item) items.push(item);
  }
  return items;
}

/** Kategorie, które biorą udział w losowaniu. */
export function getDrawableCategories(actor) {
  return getCategories(actor).filter((c) => c.tables.some((t) => t.countMax > 0));
}

/** Gotowe źródło (np. zwój z zaklęcia) z kategorią sklepu. */
function withShopFlags(source, categoryId) {
  source.system.containerId = null;
  source.flags ??= {};
  source.flags[MODULE_ID] = newItemFlags(source.flags[MODULE_ID], categoryId);
  return source;
}

/** Źródło przedmiotu do utworzenia w sklepie, z kategorią i odnośnikiem do oryginału. */
function toShopSource(item, categoryId) {
  const source = item.toObject();
  delete source._id;
  source.system.containerId = null;
  source.flags ??= {};
  source.flags[MODULE_ID] = newItemFlags(source.flags[MODULE_ID], categoryId);
  source._stats ??= {};
  source._stats.compendiumSource ??= item.pack ? item.uuid : (item._stats?.compendiumSource ?? null);
  return source;
}

/**
 * Klucz do rozpoznania "tego samego" przedmiotu przy dopisywaniu:
 * oryginał + typ amunicji (jak przy ręcznym dodawaniu), a gdy brak oryginału, nazwa.
 */
function originKey(item) {
  // Zwoje z zaklęć mają wspólny bazowy zwój danej rangi — rozróżnia je zaklęcie (nazwa „Scroll of X (Rank N)”).
  if (item?.system?.spell) return `spell:${item.name}`;
  return getStackKey(item) ?? `name:${item.name}`;
}

/**
 * Losuje asortyment sklepu.
 * @param {Actor} actor
 * @param {object} options
 * @param {"replace"|"add"} options.mode  "replace" usuwa obecny towar losowanych kategorii,
 *                                        "add" dopisuje (ten sam przedmiot zwiększa ilość).
 * @param {string[]|null} [options.categoryIds]  losowane kategorie; null = wszystkie z tabelą.
 * @returns {Promise<{created: number, stacked: number, categories: number, missingTables: string[], missingItems: string[], noParty: boolean}>}
 */
export async function randomizeStock(actor, { mode = "replace", categoryIds = null } = {}) {
  const selected = categoryIds ? new Set(categoryIds) : null;
  const categories = getDrawableCategories(actor).filter((c) => !selected || selected.has(c.id));
  const summary = { created: 0, stacked: 0, categories: 0, missingTables: [], missingItems: [], noParty: false };
  let levelCache = null;
  const toCreate = [];
  const toUpdate = [];
  const toDelete = [];

  for (const category of categories) {
    // Źródła kategorii: listy towaru albo starsze tabele losowe; brakujące (usunięte) pomijamy i zgłaszamy.
    const tables = [];
    for (const entry of category.tables) {
      const range = validateCountRange(entry.countMin, entry.countMax);
      const source = entry.listId ? getStockList(entry.listId) : await fromUuid(entry.uuid).catch(() => null);
      const valid = entry.listId ? !!source : source?.documentName === "RollTable";
      if (!valid || range.error) {
        if (!summary.missingTables.includes(category.name)) summary.missingTables.push(category.name);
        continue;
      }
      tables.push(entry.listId ? { list: source, range } : { table: source, range });
    }
    if (!tables.length) continue;
    summary.categories += 1;

    const current = actor.items.filter((i) => getItemCategory(i) === category.id && !i.isCoinage);
    if (mode === "replace") toDelete.push(...current.map((i) => i.id));

    // Jeden wpis na przedmiot: istniejący w sklepie (tryb "add") albo nowy do utworzenia.
    // Ten sam przedmiot wylosowany kilka razy (także z różnych tabel) daje jedną pozycję z sumą ilości.
    const byOrigin = new Map(
      mode === "add" ? current.map((i) => [originKey(i), { existing: i, quantity: i.quantity ?? 1 }]) : []
    );
    // Z każdego źródła osobno: liczba losowań z jego zakresu „od–do” (np. 2–4 → 2, 3 albo 4).
    const drawn = [];
    for (const { table, list, range } of tables) {
      const times = rollCount(range.min, range.max);
      if (table) {
        for (const item of await drawFromTable(table, times)) drawn.push({ item, times: 1 });
        continue;
      }
      let level = null;
      if (list.mode === "partyLevel") {
        level = levelCache ??= partyLevel() ?? NaN;
        if (Number.isNaN(level)) summary.noParty = true;
      }
      for (const { entry, quantity } of drawFromList(list, times, { level })) {
        const doc = entry.uuid ? await fromUuid(entry.uuid).catch(() => null) : null;
        // Pozycja-zwój / różdżka: z zaklęcia powstaje zwój / różdżka tej rangi (spell-consumables.js).
        const form = spellFormOf(entry);
        const source = form && doc?.type === "spell" ? await spellConsumableSource(doc, form.form, form.rank) : null;
        if (source) drawn.push({ source, times: quantity });
        else if (!form && doc && isSellable(doc)) drawn.push({ item: doc, times: quantity });
        else if (!summary.missingItems.includes(entry.name)) summary.missingItems.push(entry.name);
      }
    }
    for (const { item, source: prepared, times } of drawn) {
      const source = prepared ? withShopFlags(prepared, category.id) : toShopSource(item, category.id);
      const key = originKey(source);
      // Przedmiot z listy wylosowany N razy: N razy jego ilość z kompendium (np. 10 strzał).
      const quantity = (source.system.quantity ?? 1) * times;
      const entry = byOrigin.get(key);
      if (entry) {
        entry.quantity += quantity;
        entry.changed = true;
        summary.stacked += 1;
      } else {
        byOrigin.set(key, { source, quantity });
        summary.created += 1;
      }
    }

    for (const entry of byOrigin.values()) {
      if (entry.existing && entry.changed) toUpdate.push({ _id: entry.existing.id, "system.quantity": entry.quantity });
      if (entry.source) {
        entry.source.system.quantity = entry.quantity;
        toCreate.push(entry.source);
      }
    }
  }

  if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
  if (toUpdate.length) await actor.updateEmbeddedDocuments("Item", toUpdate);
  if (toCreate.length) await actor.createEmbeddedDocuments("Item", toCreate);
  if (summary.noParty) ui.notifications?.warn(game.i18n.localize("PF2E_SHOP.Randomize.NoParty"));
  if (summary.missingItems.length) ui.notifications?.warn(game.i18n.format("PF2E_SHOP.Randomize.MissingItems", { items: summary.missingItems.join(", ") }));
  return summary;
}
