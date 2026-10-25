/**
 * Okno potwierdzenia: usunięcie wszystkich przedmiotów z kategorii (także z "Inne").
 * `ClearCategoryDialog.confirm()` zwraca Promise<boolean>: true, gdy MG potwierdził.
 * Samo usuwanie robi wywołujący (karta sklepu).
 */
import { TEMPLATES, OTHER_CATEGORY, BUYBACK_CATEGORY } from "../constants.js";
import { getCategories, getCategoryItems } from "../shop-data.js";
import { ConfirmDialog } from "./confirm-dialog.js";

export class ClearCategoryDialog extends ConfirmDialog {
  /** Okno wspólne (`ConfirmDialog`); `ClearCategoryDialog.confirm({ actor, categoryId })`. */
  constructor({ actor, categoryId, ...options } = {}) {
    super({ id: `pf2e-shop-clear-${actor.id}-${categoryId}`, ...options });
    this.actor = actor;
    this.categoryId = categoryId;
  }

  static DEFAULT_OPTIONS = {
    window: { title: "PF2E_SHOP.ClearCategory.Title" },
    position: { width: 440, height: "auto" }
  };

  static PARTS = {
    form: { template: TEMPLATES.clearCategory }
  };

  /** „Inne” i „Odkup” to kategorie wbudowane: zostają, nie mają tabeli. */
  get isOther() {
    return [OTHER_CATEGORY, BUYBACK_CATEGORY].includes(this.categoryId);
  }

  async _prepareContext(options) {
    const name = this.categoryId === BUYBACK_CATEGORY
      ? game.i18n.localize("PF2E_SHOP.Category.Buyback")
      : this.isOther
      ? game.i18n.localize("PF2E_SHOP.Category.Other")
      : (getCategories(this.actor).find((c) => c.id === this.categoryId)?.name ?? "");
    const items = getCategoryItems(this.actor, this.categoryId)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      .map((item, i) => ({ name: item.name, img: item.img, quantity: item.quantity ?? 1, odd: i % 2 === 1 }));
    return {
      name,
      isOther: this.isOther,
      items,
      positions: items.length,
      units: items.reduce((sum, item) => sum + item.quantity, 0)
    };
  }
}
