/**
 * Indeks przedmiotów do przeglądarki list towaru: przedmioty fizyczne z kompendiów
 * systemu Pathfinder 2e i z katalogu przedmiotów świata. Własne kompendia (innych
 * modułów i świata) na razie nie są brane pod uwagę.
 *
 * Kompendia są czytane przez indeks (bez ładowania całych dokumentów), raz na sesję.
 */
import { MODULE_ID } from "./constants.js";
import { makeCoins, formatCopper, getSearchTags, rarityInfo } from "./shop-data.js";
import { filterRow } from "./sheets/filters.js";

/** Typy przedmiotów fizycznych PF2e. */
export const PHYSICAL_TYPES = new Set(["weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack", "ammo", "book"]);

const INDEX_FIELDS = [
  "system.level.value", "system.price", "system.traits.value", "system.traits.rarity",
  // Wyszukiwanie: kategoria (broń, pancerz, materiał zużywalny), grupa i baza broni i zbroi, baza tarczy, typ amunicji.
  "system.category", "system.group", "system.baseItem", "system.craftableAs",
  // Zasięg broni (`weapon-range:`).
  "system.range", "system.maxRange",
  // Premia do AC zbroi i tarczy (`armor-class:`, `shield-class:`).
  "system.acBonus",
  // Ukrywanie zwojów i podstawowych różdżek (`hiddenInItemList`).
  "system.slug"
];

let compendiumIndex = null;

/**
 * Czy przedmiot ukryć na liście przedmiotów przeglądarki list towaru. Zwoje (każdy przedmiot
 * kategorii „scroll”) i podstawowe różdżki („Magic Wand (1st-Rank Spell)”, slug
 * „magic-wand-…”) dodaje się z listy zaklęć (Spell list → „Spell as” scroll / wand), więc na liście
 * przedmiotów tylko by się dublowały. Inne różdżki (np. Wand of Fireball) zostają.
 * @param {{ type: string, name: string, system?: object }} data  przedmiot albo wpis indeksu
 */
export function hiddenInItemList(data) {
  if (data?.type !== "consumable") return false;
  const category = data.system?.category;
  if (category === "scroll") return true;
  if (category !== "wand") return false;
  const slug = String(data.system?.slug ?? "");
  return slug.startsWith("magic-wand-") || /^magic wand \(/i.test(String(data.name ?? ""));
}

/** Wpis przeglądarki z danych przedmiotu albo wpisu indeksu. */
function toEntry(data, uuid, source) {
  const system = data.system ?? {};
  const price = system.price ?? {};
  const per = Math.max(1, Number(price.per) || 1);
  const cp = makeCoins(price.value ?? {}).copperValue;
  const rarity = system.traits?.rarity ?? "common";
  const level = Number(system.level?.value) || 0;
  const tags = getSearchTags(data.type, system, rarity);
  return {
    uuid,
    source,
    name: data.name,
    img: data.img,
    type: data.type,
    level,
    priceCp: cp,
    price: `${formatCopper(cp)}${per > 1 ? ` / ${per}` : ""}`,
    ...rarityInfo(rarity),
    filter: filterRow({ name: data.name, tags, level, price: cp })
  };
}

/** Przedmioty z kompendiów systemu PF2e (wczytywane raz, potem z pamięci). */
export function loadCompendiumItems() {
  compendiumIndex ??= (async () => {
    const packs = (game.packs?.contents ?? [...(game.packs ?? [])]).filter(
      (pack) => pack.documentName === "Item" && pack.metadata?.packageType === "system" && pack.metadata?.packageName === "pf2e"
    );
    const entries = [];
    for (const pack of packs) {
      try {
        // Najpierw zwykły (lekki) indeks: kompendia bez przedmiotów fizycznych (zaklęcia,
        // atuty, klasy…) pomijamy, zanim wczytamy dodatkowe pola.
        const basic = await pack.getIndex();
        if (![...basic].some((row) => PHYSICAL_TYPES.has(row.type))) continue;
        const index = await pack.getIndex({ fields: INDEX_FIELDS });
        for (const row of index) {
          if (!PHYSICAL_TYPES.has(row.type) || hiddenInItemList(row)) continue;
          entries.push(toEntry(row, row.uuid ?? `Compendium.${pack.collection}.Item.${row._id}`, "compendium"));
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | Nie udało się wczytać indeksu ${pack.collection}`, error);
      }
    }
    return entries;
  })();
  return compendiumIndex;
}

/** Przedmioty z katalogu przedmiotów świata (zawsze aktualne). */
export function worldItems() {
  return (game.items?.contents ?? [...(game.items ?? [])])
    .filter((item) => PHYSICAL_TYPES.has(item.type) && !hiddenInItemList(item))
    .map((item) => toEntry(item, item.uuid, "world"));
}

const SPELL_FIELDS = [
  "system.level.value", "system.traits.value", "system.traits.rarity", "system.traits.traditions", "system.ritual", "system.heightening",
  "system.time.value", // koszt rzucenia (akcje) — obok nazwy w przeglądarce
  // Opis: zapasowe źródło podwyższania („Heightened (+1)” / „Heightened (4th)”), gdy zakładka jest pusta.
  "system.description.value"
];

/**
 * Rangi, na które zaklęcie można zapisać na zwoju (spell-consumables.js, `canCastAtRank`):
 * podwyższanie co N rang (`interval`) albo na konkretne rangi (`ranks`); bez podwyższania —
 * tylko ranga bazowa. Suma dwóch źródeł: zakładki „Heightening” (`system.heightening`) i opisu
 * zaklęcia („Heightened (+2)” = co 2 rangi, „Heightened (4th)” = ranga 4). Dane w kompendium
 * bywają niepełne — np. Vanishing Tracks ma w zakładce tylko rangę 4, a w opisie 2 i 4.
 */
function heightenOf(system) {
  const h = system?.heightening;
  const fromTab = h?.type === "interval" && Number(h.interval) > 0
    ? { interval: Number(h.interval) }
    : h?.type === "fixed" && h.levels
      ? { ranks: Object.keys(h.levels).map(Number).filter(Number.isInteger) }
      : null;
  const fromText = heightenFromDescription(system?.description?.value);
  const intervals = [fromTab?.interval, fromText?.interval].filter(Boolean);
  const ranks = [...new Set([...(fromTab?.ranks ?? []), ...(fromText?.ranks ?? [])])];
  if (!intervals.length && !ranks.length) return null;
  return { ...(intervals.length ? { interval: Math.min(...intervals) } : {}), ...(ranks.length ? { ranks } : {}) };
}

/** Podwyższanie z opisu zaklęcia: „Heightened (+N)” albo „Heightened (Nth)”; null, gdy brak. */
export function heightenFromDescription(html) {
  const text = String(html ?? "").replace(/<[^>]*>/g, " ");
  const intervals = [];
  const ranks = [];
  for (const [, inner] of text.matchAll(/Heightened\s*\(([^)]*)\)/gi)) {
    const plus = /^\s*\+\s*(\d+)\s*$/.exec(inner);
    const rank = /^\s*(\d+)\s*(?:st|nd|rd|th)?\s*$/i.exec(inner);
    if (plus) intervals.push(Number(plus[1]));
    else if (rank) ranks.push(Number(rank[1]));
  }
  if (!intervals.length && !ranks.length) return null;
  return {
    ...(intervals.length ? { interval: Math.min(...intervals) } : {}),
    ...(ranks.length ? { ranks: [...new Set(ranks)] } : {})
  };
}

let spellIndex = null;

/**
 * Zaklęcia z kompendiów systemu PF2e do przeglądarki list towaru (tryb „Lista zaklęć”;
 * później zwoje i różdżki). Bez sztuczek (cantrip), zaklęć skupienia i rytuałów (nie bywają
 * na zwojach ani w różdżkach). Wczytywane raz na sesję. Wpis jak przedmiotu: `level` = ranga,
 * bez ceny; znaczniki wyszukiwania `trait:`, `rarity:`, `type:spell`.
 */
export function loadBrowserSpells() {
  spellIndex ??= (async () => {
    const packs = (game.packs?.contents ?? [...(game.packs ?? [])]).filter(
      (pack) => pack.documentName === "Item" && pack.metadata?.packageType === "system" && pack.metadata?.packageName === "pf2e"
    );
    const entries = [];
    for (const pack of packs) {
      try {
        const basic = await pack.getIndex();
        if (![...basic].some((row) => row.type === "spell")) continue;
        const index = await pack.getIndex({ fields: SPELL_FIELDS });
        for (const row of index) {
          if (row.type !== "spell") continue;
          const system = row.system ?? {};
          const traits = system.traits?.value ?? [];
          // Bez sztuczek (cantrip — nie bywają na zwojach ani w różdżkach), zaklęć skupienia i rytuałów.
          if (traits.includes("cantrip") || traits.includes("focus") || system.ritual) continue;
          const rarity = system.traits?.rarity ?? "common";
          const level = Number(system.level?.value) || 0;
          const traditions = Array.isArray(system.traits?.traditions) ? system.traits.traditions : [];
          entries.push({
            uuid: row.uuid ?? `Compendium.${pack.collection}.Item.${row._id}`,
            source: "compendium",
            name: row.name,
            img: row.img,
            type: "spell",
            spell: true,
            traditions,
            heighten: heightenOf(system),
            time: String(system.time?.value ?? ""),
            level,
            priceCp: 0,
            price: "—",
            ...rarityInfo(rarity),
            filter: filterRow({ name: row.name, tags: getSearchTags("spell", system, rarity), level, price: 0 })
          });
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | Nie udało się wczytać indeksu zaklęć ${pack.collection}`, error);
      }
    }
    return entries;
  })();
  return spellIndex;
}

/** Wszystkie przedmioty przeglądarki: świat i kompendia PF2e. */
export async function loadBrowserItems() {
  return [...worldItems(), ...(await loadCompendiumItems())];
}
