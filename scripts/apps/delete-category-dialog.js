/**
 * Potwierdzenie usunięcia kategorii — wspólne okno potwierdzenia (`ConfirmDialog`)
 * ze wspólnym szablonem; tu tylko treść. `DeleteCategoryDialog.confirm({ actor, categoryId })`
 * zwraca Promise<boolean>. Samo usuwanie robi wywołujący (okno kategorii).
 */
import { getCategories, getItemCategory, getTableName } from "../shop-data.js";
import { ConfirmDialog } from "./confirm-dialog.js";

export class DeleteCategoryDialog extends ConfirmDialog {
  constructor({ actor, categoryId, ...options } = {}) {
    super({ id: `pf2e-shop-delete-${actor.id}-${categoryId}`, ...options });
    this.actor = actor;
    this.categoryId = categoryId;
  }

  static DEFAULT_OPTIONS = {
    window: { title: "PF2E_SHOP.DeleteCategory.Title" }
  };

  async _prepareContext() {
    const t = (key, data) => (data ? game.i18n.format(`PF2E_SHOP.DeleteCategory.${key}`, data) : game.i18n.localize(`PF2E_SHOP.DeleteCategory.${key}`));
    const category = getCategories(this.actor).find((c) => c.id === this.categoryId);
    const itemCount = this.actor.items.filter((i) => getItemCategory(i) === this.categoryId && !i.isCoinage).length;
    const tables = (category?.tables ?? []).map((tb) => getTableName(tb.uuid)).filter(Boolean);
    const facts = [{ icon: "fa-box-open", text: itemCount ? t("Items", { count: itemCount }) : t("NoItems") }];
    if (tables.length) {
      facts.push({ icon: "fa-table-list", text: tables.length > 1 ? t("Tables", { tables: tables.join(", ") }) : t("Table", { table: tables[0] }) });
    }
    return {
      label: t("Label"),
      name: category?.name ?? "",
      facts,
      note: t("Irreversible"),
      cancelLabel: t("Cancel"),
      confirmLabel: t("Confirm")
    };
  }
}
