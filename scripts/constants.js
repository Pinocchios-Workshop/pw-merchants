export const MODULE_ID = "pw-merchant-dev";

/**
 * Flaga własnej ceny przedmiotu (czyszczona przy wyjściu przedmiotu ze sklepu, pricing.js).
 * Kształt wszystkich flag modułu, odczyt, zapis i migracje: shop-store.js.
 */
export const ITEM_PRICE_FLAG = "basePrice";

/** Id wirtualnej kategorii dla przedmiotów bez przypisania. */
export const OTHER_CATEGORY = "other";

/** Id specjalnej kategorii „Odkup”: przedmioty sprzedane sklepowi przez graczy. */
export const BUYBACK_CATEGORY = "buyback";

/** Ceny w „Odkupie”: 75% ceny bazowej, bez mnożnika sklepu. */
export const BUYBACK_MODIFIER = 0.75;

export const TEMPLATES = {
  merchantSheet: `modules/${MODULE_ID}/templates/merchant-sheet.hbs`,
  categoryConfig: `modules/${MODULE_ID}/templates/category-config.hbs`,
  randomize: `modules/${MODULE_ID}/templates/randomize.hbs`,
  confirmDelete: `modules/${MODULE_ID}/templates/confirm-delete.hbs`,
  clearCategory: `modules/${MODULE_ID}/templates/clear-category.hbs`,
  itemConfig: `modules/${MODULE_ID}/templates/item-config.hbs`,
  purseConfig: `modules/${MODULE_ID}/templates/purse-config.hbs`,
  descriptionConfig: `modules/${MODULE_ID}/templates/description-config.hbs`,
  purchase: `modules/${MODULE_ID}/templates/purchase.hbs`,
  sell: `modules/${MODULE_ID}/templates/sell.hbs`,
  sellReview: `modules/${MODULE_ID}/templates/sell-review.hbs`,
  stockLists: `modules/${MODULE_ID}/templates/stock-lists.hbs`,
  syntaxGuide: `modules/${MODULE_ID}/templates/syntax-guide.hbs`,
  filtersPartial: `modules/${MODULE_ID}/templates/partials/filters.hbs`
};

/** Kolory rzadkości jak w tagach PF2e. */
/**
 * Zasięgi broni dostępne na karcie broni PF2e (stopy, przyrost zasięgu) — kopia `WEAPON_RANGES`
 * z systemu (src/module/item/weapon/values.ts), bo PF2e nie wystawia jej w `CONFIG`. Służy tylko
 * do listy „All values”; wyszukiwanie przyjmuje każdy zasięg zapisany na broni.
 */
export const WEAPON_RANGES = Object.freeze([10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 140, 150, 180, 200, 240, 300]);

/**
 * Premie do AC w „All values” (`armor-class:`, `shield-class:`): wartości spotykane w PF2e.
 * Wyszukiwanie przyjmuje każdą liczbę zapisaną na przedmiocie.
 */
export const ARMOR_AC_BONUSES = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
export const SHIELD_AC_BONUSES = Object.freeze([0, 1, 2, 3]);

export const RARITY_COLORS = Object.freeze({
  common: null,
  uncommon: "#98513d",
  rare: "#002664",
  unique: "#54166e"
});
