/**
 * Testy formatu danych: każdy plik z `fixtures/` (stara i aktualna wersja danych) musi
 * dać po odczycie dokładnie `expected`, a ponowny odczyt wyniku — to samo (odczyt
 * jest stały). Uruchomienie: `node tests/run-tests.mjs` (Node 18+, bez Foundry).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual, strictEqual } from "node:assert";

// Minimalne zastępstwo Foundry dla czystych funkcji odczytu.
globalThis.foundry = { utils: { deepClone: (v) => structuredClone(v), randomID: () => Math.random().toString(36).slice(2, 18) } };

const { readShopDoc, readItemFlags, SHOP_SCHEMA } = await import("../scripts/shop-store.js");
const { readStockList, SCHEMA } = await import("../scripts/stock-lists-store.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n    ${String(error.message).split("\n").slice(0, 12).join("\n    ")}`);
  }
}

for (const file of readdirSync(join(root, "shop"))) {
  const fx = JSON.parse(readFileSync(join(root, "shop", file), "utf8"));
  const read = fx.item ? (raw) => readItemFlags(raw) : (raw) => readShopDoc(raw);
  const pick = (r) => (fx.item ? r.flags : r.doc);
  const input = structuredClone(fx.input);
  check(`shop/${file}: wynik`, () => deepStrictEqual(pick(read(fx.input)), fx.expected));
  check(`shop/${file}: dane wejściowe niezmienione`, () => deepStrictEqual(fx.input, input));
  check(`shop/${file}: ponowny odczyt bez zmian`, () => deepStrictEqual(pick(read(pick(read(fx.input)))), fx.expected));
  check(`shop/${file}: nowsza wersja`, () => strictEqual(read(fx.input).newer, !!fx.newer));
}

for (const file of readdirSync(join(root, "stock-list"))) {
  const fx = JSON.parse(readFileSync(join(root, "stock-list", file), "utf8"));
  const result = readStockList(fx.input);
  if (fx.error) {
    check(`stock-list/${file}: błąd`, () => strictEqual(result.error, fx.error));
    continue;
  }
  check(`stock-list/${file}: wynik`, () => deepStrictEqual(result.list, fx.expected));
  check(`stock-list/${file}: ponowny odczyt bez zmian`, () => deepStrictEqual(readStockList(result.list).list, fx.expected));
}

// Każda wersja schematu ma swój plik testowy (od 0 do aktualnej).
for (let s = 0; s <= SHOP_SCHEMA; s += 1) {
  check(`sklep: plik testowy schematu ${s}`, () => strictEqual(readdirSync(join(root, "shop")).some((f) => f.startsWith(`schema-${s}`)), true));
}
for (let s = 0; s <= SCHEMA; s += 1) {
  check(`lista: plik testowy schematu ${s}`, () => strictEqual(readdirSync(join(root, "stock-list")).some((f) => f.startsWith(`schema-${s}`)), true));
}

/* ---------- Migracja świata i zapis (zastępstwo dokumentów Foundry) ---------- */

const MODULE = (await import("../scripts/constants.js")).MODULE_ID;
const { migrateWorld, restoreShopBackup, writeShop, DATA_VERSION } = await import("../scripts/shop-store.js");
const { migrateStockLists, saveStockList, getStockLists } = await import("../scripts/stock-lists-store.js");

/** Zapis jak w Foundry: ścieżka „a.b.c”, obiekty scalane, tablice i wartości podmieniane. */
function applyUpdate(target, changes) {
  for (const [path, value] of Object.entries(changes)) {
    if (path === "_id") continue;
    const keys = path.split(".");
    let obj = target;
    for (const k of keys.slice(0, -1)) obj = obj[k] ??= {};
    const last = keys.at(-1);
    const merge = (a, b) => {
      if (b && typeof b === "object" && !Array.isArray(b) && a && typeof a === "object" && !Array.isArray(a)) {
        for (const [k, v] of Object.entries(b)) a[k] = merge(a[k], v);
        return a;
      }
      return structuredClone(b);
    };
    obj[last] = merge(obj[last], value);
  }
}
function mockActor(name, flags, items = [], extra = {}) {
  const list = structuredClone(items).map((i) => Object.assign(i, { update: async (c) => applyUpdate(i, c) }));
  const coll = Object.assign(list, { has: (id) => list.some((i) => i.id === id) });
  return {
    name, flags: structuredClone(flags), items: coll, type: "loot", system: { lootSheetType: "Merchant" }, ...extra,
    async update(c) { applyUpdate(this, c); },
    async updateEmbeddedDocuments(_t, updates) { for (const u of updates) applyUpdate(list.find((i) => i.id === u._id), u); }
  };
}
const settings = new Map();
const notes = [];
const legacyShop = JSON.parse(readFileSync(join(root, "shop", "schema-0-legacy.json"), "utf8"));
const legacyItem = JSON.parse(readFileSync(join(root, "shop", "item-schema-0.json"), "utf8"));
const legacyList = JSON.parse(readFileSync(join(root, "stock-list", "schema-0.json"), "utf8"));
const newerList = JSON.parse(readFileSync(join(root, "stock-list", "schema-99-newer.json"), "utf8"));
const shop = mockActor("Sklep", { [MODULE]: legacyShop.input }, [{ id: "i1", flags: { [MODULE]: legacyItem.input } }, { id: "i2", flags: {} }]);
const character = mockActor("Postać", {}, [{ id: "c1", flags: { [MODULE]: { basePrice: null } } }], { type: "character", system: {} });
const newerShop = mockActor("Nowszy", { [MODULE]: { schema: 99, shop: { priceModifier: 1.5 } } });
settings.set("stockLists", [legacyList.input, newerList.input]);
settings.set("dataVersion", 0);
globalThis.game = {
  user: { isGM: true }, users: { activeGM: { isSelf: true } },
  actors: [shop, character, newerShop], scenes: [],
  modules: { get: () => ({ title: "Test", version: "test" }) },
  settings: { get: (_m, k) => structuredClone(settings.get(k)), set: async (_m, k, v) => settings.set(k, structuredClone(v)) },
  i18n: { format: (k) => k, localize: (k) => k }
};
globalThis.ui = { notifications: { info: (m) => notes.push(m), warn: (m) => notes.push(m), error: (m) => notes.push(m) } };

await migrateWorld(migrateStockLists);
const flags = shop.flags[MODULE];
check("migracja: sklep w schemacie 1", () => deepStrictEqual(readShopDoc(flags).doc.categories, legacyShop.expected.categories));
check("migracja: zapisany schemat", () => strictEqual(flags.schema, 1));
check("migracja: stare pola kategorii usunięte", () => strictEqual(flags.categories[0].tableUuid, undefined));
check("migracja: kopia starych danych", () => deepStrictEqual(flags.backup.shop, legacyShop.input));
check("migracja: kopia flag przedmiotu", () => deepStrictEqual(flags.backup.items.i1, legacyItem.input));
check("migracja: cena przedmiotu bez platyny", () => deepStrictEqual(readItemFlags(shop.items[0].flags[MODULE]).flags.basePrice, legacyItem.expected.basePrice));
check("migracja: przedmiot bez danych modułu nietknięty", () => deepStrictEqual(shop.items[1].flags, {}));
check("migracja: postać gracza nietknięta", () => deepStrictEqual(character.items[0].flags[MODULE], { basePrice: null }));
check("migracja: sklep z nowszej wersji nietknięty", () => deepStrictEqual(newerShop.flags[MODULE], { schema: 99, shop: { priceModifier: 1.5 } }));
check("migracja: wersja danych świata", () => strictEqual(settings.get("dataVersion"), DATA_VERSION));
check("migracja: listy w schemacie 1", () => strictEqual(settings.get("stockLists")[0].schema, 1));
check("migracja: lista z nowszej wersji zachowana", () => deepStrictEqual(settings.get("stockLists")[1], newerList.input));
check("migracja: kopia list", () => deepStrictEqual(settings.get("stockListsBackup").lists, [legacyList.input, newerList.input]));
check("migracja: komunikat", () => strictEqual(notes.includes("PF2E_SHOP.Data.Migrated"), true));

// Zapis nie kasuje listy z nowszej wersji; nie nadpisuje sklepu z nowszej wersji.
await saveStockList({ ...getStockLists()[0], name: "Zmieniona" });
check("zapis listy: lista z nowszej wersji zachowana", () => deepStrictEqual(settings.get("stockLists").find((l) => l.id === "list9"), newerList.input));
check("zapis listy: zmiana zapisana", () => strictEqual(getStockLists()[0].name, "Zmieniona"));
const refused = await writeShop(newerShop, { shop: { priceModifier: 1 } });
check("zapis sklepu z nowszej wersji: odmowa", () => strictEqual(refused, false));
check("zapis sklepu z nowszej wersji: dane bez zmian", () => strictEqual(newerShop.flags[MODULE].shop.priceModifier, 1.5));

// Drugi start: nic do migracji, kopia bez zmian.
const backupDate = flags.backup.date;
notes.length = 0;
await migrateWorld(migrateStockLists);
check("ponowny start: bez komunikatu", () => strictEqual(notes.length, 0));
check("ponowny start: kopia bez zmian", () => strictEqual(flags.backup.date, backupDate));

// Przywrócenie kopii.
await restoreShopBackup(shop);
check("przywrócenie: stare kategorie", () => deepStrictEqual(shop.flags[MODULE].categories, legacyShop.input.categories));
check("przywrócenie: stara cena przedmiotu", () => strictEqual(shop.items[0].flags[MODULE].basePrice.pp, 1));
check("przywrócenie: cena przedmiotu odczytana jak przed migracją", () => deepStrictEqual(readItemFlags(shop.items[0].flags[MODULE]).flags.basePrice, legacyItem.expected.basePrice));
check("przywrócenie: odczyt nadal poprawny (migracja przy odczycie)", () => deepStrictEqual(readShopDoc(shop.flags[MODULE]).doc.categories, legacyShop.expected.categories));

// Świat z nowszej wersji danych: tylko ostrzeżenie.
settings.set("dataVersion", DATA_VERSION + 1);
notes.length = 0;
await migrateWorld(migrateStockLists);
check("nowszy świat: ostrzeżenie", () => strictEqual(notes[0], "PF2E_SHOP.Data.NewerWorld"));
check("nowszy świat: wersja bez zmian", () => strictEqual(settings.get("dataVersion"), DATA_VERSION + 1));

/* ---------- Operatory logiczne wyszukiwania (filters.js, czyste funkcje) ---------- */

const { parseGroup: pg, matches: rowMatches, filterRow: mkRow } = await import("../scripts/sheets/filters.js");

// Przykładowe wiersze jak na karcie sklepu / w przeglądarce (nazwa, znaczniki, poziom, cena cp).
const rows = {
  agileFinesse: mkRow({ name: "Rapier", tags: ["trait:agile", "trait:finesse", "type:weapon", "weapon-group:sword", "rarity:common"], level: 1, price: 200 }),
  axeCommon: mkRow({ name: "Battle Axe", tags: ["type:weapon", "weapon-group:axe", "rarity:common"], level: 1, price: 100 }),
  axeRare: mkRow({ name: "Cursed Axe", tags: ["type:weapon", "weapon-group:axe", "rarity:rare"], level: 5, price: 900 }),
  swordUncommon: mkRow({ name: "Fine Sword", tags: ["type:weapon", "weapon-group:sword", "rarity:uncommon"], level: 3, price: 500 }),
  shield: mkRow({ name: "Steel Shield", tags: ["type:shield", "rarity:common"], level: 0, price: 50 }),
  potion: mkRow({ name: "Healing Potion", tags: ["type:consumable", "consumable-category:potion", "rarity:common"], level: 1, price: 30 }),
  elixir: mkRow({ name: "Elixir of Life", tags: ["type:consumable", "consumable-category:elixir", "rarity:common"], level: 1, price: 30 }),
  wandFireball: mkRow({ name: "Wand of Fireball (Rank 3)", tags: ["type:consumable", "rarity:common"], level: 5, price: 700 }),
  wandWonder: mkRow({ name: "Spellstrike Wand", tags: ["type:consumable", "rarity:rare"], level: 5, price: 700 })
};
const q = (search) => ({ search, sort: "level", levelMin: null, levelMax: null, priceMin: null, priceMax: null });
const found = (search) => Object.entries(rows).filter(([, r]) => rowMatches(r, q(search))).map(([k]) => k).sort();
const eq = (search, expected) => check(`szukaj „${search}”`, () => deepStrictEqual(found(search), [...expected].sort()));

// „I” (spacja): wszystkie warunki naraz, kolejność bez znaczenia.
eq("trait:agile trait:finesse", ["agileFinesse"]);
eq("type:weapon rarity:uncommon", ["swordUncommon"]);
eq("rarity:uncommon type:weapon", ["swordUncommon"]); // kolejność bez znaczenia
eq("sword", ["swordUncommon"]); // fragment nazwy (Rapier nie ma „sword” w nazwie)

// „Lub” (|): pełny i skrócony, jeden klucz.
eq("weapon-group:axe|weapon-group:sword", ["agileFinesse", "axeCommon", "axeRare", "swordUncommon"]);
eq("weapon-group:axe|sword", ["agileFinesse", "axeCommon", "axeRare", "swordUncommon"]); // skrót = pełny
eq("type:weapon|shield", ["agileFinesse", "axeCommon", "axeRare", "swordUncommon", "shield"]);
eq("potion|elixir", ["potion", "elixir"]); // fragmenty nazwy
eq("weapon-group:axe|sword rarity:rare", ["axeRare"]); // grupa + warunek

// „Lub” z różnymi kluczami / pomieszany / nieznany klucz — niczego nie znajdzie.
check("OR różne klucze = pusta grupa", () => deepStrictEqual(pg("trait:acid|rarity:rare"), []));
check("OR pomieszany = pusta grupa", () => deepStrictEqual(pg("weapon-group:axe|sword|type:weapon"), []));
check("OR nieznany klucz = pusta grupa", () => deepStrictEqual(pg("weapon-group:axe|tag:x"), []));
eq("trait:acid|rarity:rare", []); // błędna grupa → nic

// „Nie” (!): wyklucza znacznik albo fragment nazwy.
eq("weapon-group:axe !rarity:rare", ["axeCommon"]); // topory bez rare → tylko zwykły
eq("!rarity:rare", ["agileFinesse", "axeCommon", "swordUncommon", "shield", "potion", "elixir", "wandFireball"]); // wszystko poza rare
eq("wand !of", ["wandWonder"]); // „wand” w nazwie, bez „of” (Wand of Fireball ma „of”)
eq("type:consumable !consumable-category:potion", ["elixir", "wandFireball", "wandWonder"]); // konsumpcyjne poza potion

// Łączenia operatorów nie ma: „!” z „|” blokuje całe wyszukiwanie.
eq("!trait:acid|fire", []);
eq("weapon-group:axe !rarity:rare|uncommon", []); // NOT + OR → nic

/* ---------- Skrócone formy kluczy (t: = trait:, ty: = type:, r: = rarity:) ---------- */

const { parseTerm: pt, parseSearch: ps, SEARCH_KEYS: KEYS, SEARCH_KEY_SHORT: SHORT, canonicalKey } = await import("../scripts/sheets/filters.js");
check("skróty: tabela", () => deepStrictEqual({ ...SHORT }, {
  r: "rarity", t: "trait", ty: "type", wct: "weapon-category", wg: "weapon-group", wb: "weapon-base", wr: "weapon-range",
  act: "armor-category", ag: "armor-group", ab: "armor-base", ac: "armor-class", sc: "shield-class", sb: "shield-base",
  cct: "consumable-category", amt: "ammunition-type", spt: "spell-tradition"
}));
check("skróty: każdy skrót wskazuje istniejący klucz", () => { for (const k of Object.values(SHORT)) strictEqual(KEYS.includes(k), true); });
check("skróty: canonicalKey", () => { strictEqual(canonicalKey("R"), "rarity"); strictEqual(canonicalKey("type"), "type"); });
check("skróty: ty:weapon → type:weapon", () => deepStrictEqual(pt("ty:weapon"), { tag: "type:weapon" }));
check("skróty: t:magical → trait:magical", () => deepStrictEqual(pt("t:magical"), { tag: "trait:magical" }));
check("skróty: R:Rare (wielkość liter)", () => deepStrictEqual(pt("R:Rare"), { tag: "rarity:rare" }));
check("skróty: „ty:” bez wartości = nic", () => strictEqual(pt("ty:"), null));
check("skróty: „tr:x” to zwykły tekst", () => deepStrictEqual(pt("tr:x"), { text: "tr:x" }));
check("skróty: grupa skrócona z krótkim kluczem", () => deepStrictEqual(pg("ty:weapon|shield"), [{ tag: "type:weapon" }, { tag: "type:shield" }]));
check("skróty: grupa pełna mieszająca t: i type:", () => deepStrictEqual(pg("ty:weapon|type:shield"), [{ tag: "type:weapon" }, { tag: "type:shield" }]));
check("skróty: grupa r:|t: = różne klucze", () => deepStrictEqual(pg("r:rare|ty:weapon"), []));
check("skróty: parseSearch zapisuje pełny klucz", () => deepStrictEqual(ps("ty:weapon r:rare").tags, ["type:weapon", "rarity:rare"]));
check("skróty: NOT ze skrótem", () => deepStrictEqual(ps("!r:rare").notTags, ["rarity:rare"]));
eq("ty:weapon", ["agileFinesse", "axeCommon", "axeRare", "swordUncommon"]);
eq("ty:weapon r:rare", ["axeRare"]);
eq("ty:weapon|shield", ["agileFinesse", "axeCommon", "axeRare", "swordUncommon", "shield"]);
eq("r:uncommon|rare", ["axeRare", "swordUncommon", "wandWonder"]);
eq("weapon-group:sword r:uncommon", ["swordUncommon"]);
eq("ty:weapon !r:rare", ["agileFinesse", "axeCommon", "swordUncommon"]);
eq("t:agile ty:weapon", ["agileFinesse"]);
eq("ty:weapon type:weapon", ["agileFinesse", "axeCommon", "axeRare", "swordUncommon"]); // skrót = pełny, razem

/* ---------- Broń: weapon-category / weapon-group / weapon-base / weapon-range ---------- */

globalThis.CONFIG = {
  PF2E: {
    weaponCategories: { simple: "Simple Weapon", martial: "Martial Weapon", advanced: "Advanced Weapon" },
    weaponGroups: { sword: "Sword", bow: "Bow", crossbow: "Crossbow", knife: "Knife" },
    baseWeaponTypes: { longsword: "Longsword", shortbow: "Shortbow", "heavy-crossbow": "Heavy Crossbow", dagger: "Dagger" },
    armorCategories: { unarmored: "Unarmored", light: "Light Armor", medium: "Medium Armor", heavy: "Heavy Armor", "light-barding": "Light Barding" },
    armorGroups: { plate: "Plate", chain: "Chain", leather: "Leather" },
    baseArmorTypes: { "full-plate": "Full Plate", "chain-mail": "Chain Mail", "leather-armor": "Leather Armor" },
    baseShieldTypes: { "steel-shield": "Steel Shield", "tower-shield": "Tower Shield", "fortress-shield": "Fortress Shield", buckler: "Buckler" },
    consumableCategories: { potion: "Potion", scroll: "Scroll", wand: "Wand", elixir: "Elixir" },
    ammoTypes: { arrows: "Arrows", bolts: "Bolts" },
    magicTraditions: { arcane: "Arcane", divine: "Divine", occult: "Occult", primal: "Primal" },
    weaponTraits: { "thrown-10": "Thrown 10 ft.", magical: "Magical" }
  }
};
const { getSearchTags, weaponRange } = await import("../scripts/shop-data.js");
const weapon = (name, sys, rarity = "common") => mkRow({ name, tags: getSearchTags("weapon", sys, rarity), level: 1, price: 100 });
const weapons = {
  longsword: weapon("Longsword", { category: "martial", group: "sword", baseItem: "longsword", range: null }),
  flaming: weapon("Flaming Longsword", { category: "martial", group: "sword", baseItem: "longsword", range: null, traits: { value: ["magical"] } }, "uncommon"),
  shortbow: weapon("Shortbow", { category: "martial", group: "bow", baseItem: "shortbow", range: 60 }),
  crossbow: weapon("Heavy Crossbow", { category: "simple", group: "crossbow", baseItem: "heavy-crossbow", range: 120 }),
  dagger: weapon("Dagger", { category: "simple", group: "knife", baseItem: "dagger", range: null, traits: { value: ["thrown-10"] } })
};
const wFound = (search) => Object.entries(weapons).filter(([, r]) => rowMatches(r, q(search))).map(([k]) => k).sort();
const weq = (search, expected) => check(`broń: „${search}”`, () => deepStrictEqual(wFound(search), [...expected].sort()));

check("broń: znaczniki miecza", () => deepStrictEqual(getSearchTags("weapon", { category: "martial", group: "sword", baseItem: "longsword" }, "common").sort(),
  ["rarity:common", "type:weapon", "weapon-base:longsword", "weapon-category:martial", "weapon-group:sword", "weapon-range:melee"]));
check("broń: zasięg — przyrost, maksymalny, wręcz", () => {
  strictEqual(weaponRange({ range: 60 }), "60");
  strictEqual(weaponRange({ range: null, maxRange: 100 }), "100");
  strictEqual(weaponRange({ range: null }), "melee");
  strictEqual(weaponRange({}), "melee");
});
check("broń: zasięg tylko dla broni", () => strictEqual(getSearchTags("armor", { category: "light" }).some((t) => t.startsWith("weapon-range:")), false));
check("pancerz: tylko wartość bazowa kategorii", () => strictEqual(getSearchTags("armor", { category: "light" }).includes("armor-category:Light Armor"), false));
check("broń: „wc:” to już nie skrót", () => deepStrictEqual(pt("wc:martial"), { text: "wc:martial" }));

// Pełne i skrócone klucze — ten sam wynik.
for (const [full, short, expected] of [
  ["weapon-category:martial", "wct:martial", ["longsword", "flaming", "shortbow"]],
  ["weapon-category:simple|advanced", "wct:simple|advanced", ["crossbow", "dagger"]],
  ["weapon-group:sword", "wg:sword", ["longsword", "flaming"]],
  ["weapon-group:bow|crossbow", "wg:bow|crossbow", ["shortbow", "crossbow"]],
  ["weapon-base:longsword", "wb:longsword", ["longsword", "flaming"]],
  ["weapon-base:heavy-crossbow", "wb:heavy-crossbow", ["crossbow"]],
  ["weapon-range:melee", "wr:melee", ["longsword", "flaming", "dagger"]],
  ["weapon-range:60", "wr:60", ["shortbow"]],
  ["weapon-range:60|120", "wr:60|120", ["shortbow", "crossbow"]],
  ["!weapon-range:melee", "!wr:melee", ["shortbow", "crossbow"]]
]) {
  weq(full, expected);
  weq(short, expected);
}
weq("wr:melee|weapon-range:60", ["longsword", "flaming", "dagger", "shortbow"]); // skrót i pełny w jednej grupie
weq("wb:longsword rarity:uncommon", ["flaming"]);
weq("wct:martial wg:sword !r:uncommon", ["longsword"]);
weq("wg:knife t:thrown-10", ["dagger"]); // broń rzucana to nadal „melee”, rzut — przez cechę
weq("wr:melee wg:bow", []);
// Tylko wartości bazowe: etykiety („martial-weapon”, „heavy crossbow”) nie działają.
weq("weapon-category:martial-weapon", []);
weq("wct:martial-weapon", []);
weq("weapon-group:Sword", ["longsword", "flaming"]); // wielkość liter bez znaczenia (to wartość bazowa)
weq("wr:60-ft", []);
// Przykłady z Syntax Guide → Weapons.
weq("wct:simple|martial", ["longsword", "flaming", "shortbow", "crossbow", "dagger"]);
weq("wb:dagger rarity:uncommon", []);

/* ---------- Zbroja, tarcza, materiały zużywalne, amunicja, zaklęcia ---------- */

const gear = (type, name, sys, rarity = "common") => mkRow({ name, tags: getSearchTags(type, sys, rarity), level: 1, price: 100 });
const items = {
  fullPlate: gear("armor", "Full Plate", { category: "heavy", group: "plate", baseItem: "full-plate", acBonus: 6 }),
  chainMail: gear("armor", "Chain Mail", { category: "medium", group: "chain", baseItem: "chain-mail", acBonus: 4 }, "uncommon"),
  leather: gear("armor", "Leather Armor", { category: "light", group: "leather", baseItem: "leather-armor", acBonus: 1 }),
  barding: gear("armor", "Light Barding", { category: "light-barding", acBonus: 2 }),
  clothing: gear("armor", "Explorer's Clothing", { category: "unarmored", acBonus: 0 }),
  steel: gear("shield", "Steel Shield", { baseItem: "steel-shield", acBonus: 2 }),
  tower: gear("shield", "Tower Shield", { baseItem: "tower-shield", acBonus: 2 }, "uncommon"),
  buckler: gear("shield", "Buckler", { baseItem: "buckler", acBonus: 1 }),
  potion: gear("consumable", "Healing Potion", { category: "potion" }),
  scroll: gear("consumable", "Scroll of Fireball", { category: "scroll" }),
  arrows: gear("ammo", "Arrows", { baseItem: "arrows" }),
  bolts: gear("ammo", "Bolts", { baseItem: "bolts" }),
  heal: gear("spell", "Heal", { traits: { traditions: ["divine", "primal"] } }),
  fireball: gear("spell", "Fireball", { traits: { traditions: ["arcane", "primal"] } }),
  fear: gear("spell", "Fear", { traits: { traditions: ["arcane", "divine", "occult", "primal"] } }),
  arcaneWand: gear("equipment", "Arcane Staff", { traits: { value: ["arcane"] } })
};
const iFound = (search) => Object.entries(items).filter(([, r]) => rowMatches(r, q(search))).map(([k]) => k).sort();
const ieq = (search, expected) => check(`przedmioty: „${search}”`, () => deepStrictEqual(iFound(search), [...expected].sort()));

for (const [full, short, expected] of [
  ["armor-category:heavy", "act:heavy", ["fullPlate"]],
  ["armor-category:light|medium", "act:light|medium", ["chainMail", "leather"]],
  ["armor-category:light-barding", "act:light-barding", ["barding"]],
  ["armor-category:unarmored", "act:unarmored", ["clothing"]],
  ["armor-group:plate", "ag:plate", ["fullPlate"]],
  ["armor-group:chain|leather", "ag:chain|leather", ["chainMail", "leather"]],
  ["armor-base:full-plate", "ab:full-plate", ["fullPlate"]],
  ["armor-class:6", "ac:6", ["fullPlate"]],
  ["armor-class:1|2", "ac:1|2", ["leather", "barding"]],
  ["armor-class:0", "ac:0", ["clothing"]],
  ["shield-class:2", "sc:2", ["steel", "tower"]],
  ["shield-base:steel-shield", "sb:steel-shield", ["steel"]],
  ["shield-base:tower-shield|fortress-shield", "sb:tower-shield|fortress-shield", ["tower"]],
  ["consumable-category:potion", "cct:potion", ["potion"]],
  ["consumable-category:scroll|wand", "cct:scroll|wand", ["scroll"]],
  ["ammunition-type:arrows", "amt:arrows", ["arrows"]],
  ["ammunition-type:bolts|arrows", "amt:bolts|arrows", ["arrows", "bolts"]],
  ["spell-tradition:divine", "spt:divine", ["heal", "fear"]],
  ["spell-tradition:arcane|occult", "spt:arcane|occult", ["fireball", "fear"]],
  ["!spell-tradition:arcane", "!spt:arcane", ["fullPlate", "chainMail", "leather", "barding", "clothing", "steel", "tower", "buckler", "potion", "scroll", "arrows", "bolts", "heal", "arcaneWand"]]
]) {
  ieq(full, expected);
  ieq(short, expected);
}
// Tylko wartości bazowe: etykiety nie działają.
ieq("armor-category:light-armor", []);
ieq("act:heavy-armor", []);
ieq("cct:potions", []);
// Klasa zbroi to nie klasa tarczy (ta sama liczba, różne klucze).
ieq("ac:2", ["barding"]);
ieq("sc:2 r:uncommon", ["tower"]);
// Tradycja zaklęcia ≠ cecha przedmiotu.
ieq("spt:arcane", ["fireball", "fear"]);
check("„st” już nie jest skrótem", () => deepStrictEqual(pt("st:arcane"), { text: "st:arcane" }));
ieq("t:arcane", ["arcaneWand"]);
// Przykłady z Syntax Guide.
ieq("ab:chain-mail rarity:uncommon", ["chainMail"]);
ieq("sc:1 rarity:common", ["buckler"]);
check("„ct” nie jest skrótem („act”, „wct”, „cct” są)", () => deepStrictEqual(pt("ct:heavy"), { text: "ct:heavy" }));
check("„at” i „wc” już nie są skrótami", () => { deepStrictEqual(pt("at:arrows"), { text: "at:arrows" }); deepStrictEqual(pt("cc:potion"), { text: "cc:potion" }); });

/* ---------- Lista przedmiotów przeglądarki: bez zwojów i podstawowych różdżek ---------- */

{
  const { hiddenInItemList: hidden } = await import("../scripts/item-index.js");
  const c = (name, category, slug) => ({ type: "consumable", name, system: { category, slug } });
  check("ukryte: zwój podstawowy", () => strictEqual(hidden(c("Scroll of 3rd-rank Spell", "scroll", "scroll-of-3rd-rank-spell")), true));
  check("ukryte: każdy zwój", () => strictEqual(hidden(c("Scroll of Fireball", "scroll", "")), true));
  check("ukryte: Magic Wand (po slugu)", () => strictEqual(hidden(c("Różdżka magiczna (zaklęcie 1. kręgu)", "wand", "magic-wand-1st-rank-spell")), true));
  check("ukryte: Magic Wand (po nazwie)", () => strictEqual(hidden(c("Magic Wand (2nd-Rank Spell)", "wand", "")), true));
  check("widoczne: inna różdżka", () => strictEqual(hidden(c("Wand of Fireball (Rank 3)", "wand", "wand-of-fireball")), false));
  check("widoczne: mikstura", () => strictEqual(hidden(c("Healing Potion", "potion", "healing-potion")), false));
  check("widoczne: broń o nazwie Magic Wand", () => strictEqual(hidden({ type: "weapon", name: "Magic Wand (x)", system: {} }), false));
}

/* ---------- Wszystkie przykłady z Syntax Guide (lang/en.json) ---------- */

{
  const guide = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8")).PF2E_SHOP.SyntaxGuide;
  const queries = [];
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node)) {
      if (!v || typeof v !== "object") continue;
      if (typeof v.Query === "string") queries.push([`${path}${k}`, v.Query]);
      else walk(v, `${path}${k}.`);
    }
  };
  walk(guide, "");
  check("przykłady guide: znaleziono wszystkie (≥ 40)", () => strictEqual(queries.length >= 40, true));
  for (const [id, query] of queries) {
    const parsed = ps(query);
    // Jedyny przykład, który ma nie działać („Won't work”): !trait:acid|fire.
    const mustFail = id === "logic.combine.Ex1";
    check(`przykład ${id} „${query}”: ${mustFail ? "zablokowany" : "rozpoznany"}`, () => {
      strictEqual(parsed.blocked, mustFail);
      if (mustFail) return;
      for (const tag of [...parsed.tags, ...parsed.notTags, ...parsed.groups.flat().map((t) => t.tag).filter(Boolean)]) {
        strictEqual(KEYS.includes(tag.slice(0, tag.indexOf(":"))), true, tag); // tylko pełne klucze
        strictEqual(tag.length > tag.indexOf(":") + 1, true, tag);
      }
      for (const group of parsed.groups) strictEqual(group.length > 0, true); // grupa nie jest pusta (błędna)
      strictEqual(parsed.tags.length + parsed.notTags.length + parsed.groups.length + parsed.notText.length > 0 || parsed.text.length > 0, true);
    });
  }
  // Przykłady zapisane w guide mają wyniki zgodne z opisem (zbiór testowy wyżej).
  eq("trait:magical sword", []); // brak magicznych mieczy w zbiorze
  eq("weapon-group:sword rarity:unique", []); // brak unikalnych mieczy w zbiorze
  eq("type:shield r:rare", []); // brak rzadkich tarcz w zbiorze
  eq("wand !of", ["wandWonder"]);
  check("przykład „!trait:acid|fire” nic nie znajduje", () => deepStrictEqual(found("!trait:acid|fire"), []));
}

/* ---------- Układ „All values” (guide-layout.js) ---------- */

const { columnCounts, arrangeColumns, columnsThatFit } = await import("../scripts/apps/guide-layout.js");
check("układ: 10 wartości w 3 kolumnach → 4/3/3", () => deepStrictEqual(columnCounts(10, 3), [4, 3, 3]));
check("układ: 9 w 3 → 3/3/3", () => deepStrictEqual(columnCounts(9, 3), [3, 3, 3]));
check("układ: kolumn nie więcej niż wartości", () => deepStrictEqual(columnCounts(2, 5), [1, 1]));
check("układ: pusta lista", () => deepStrictEqual(columnCounts(0, 3), []));
check("układ: suma wierszy = liczba wartości", () => {
  for (const [n, c] of [[7, 3], [354, 4], [356, 7], [1, 1]]) strictEqual(columnCounts(n, c).reduce((a, b) => a + b, 0), n);
});
check("układ: alfabetycznie od góry kolumnami", () =>
  deepStrictEqual(arrangeColumns(["a", "b", "c", "d", "e"], 2), [["a", "b", "c"], ["d", "e"]]));
check("układ: ile kolumn się zmieści", () => {
  strictEqual(columnsThatFit(500, 100, 12, 99), 4);
  strictEqual(columnsThatFit(50, 100, 12, 99), 1);
  strictEqual(columnsThatFit(500, 100, 12, 2), 2);
});

console.log(`${passed} OK, ${failures.length} błędów`);
for (const f of failures) console.log(`✗ ${f}`);
process.exit(failures.length ? 1 : 0);
