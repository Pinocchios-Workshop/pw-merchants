/**
 * Potwierdzenie usunięcia listy towaru — wspólne okno potwierdzenia (`ConfirmDialog`)
 * ze wspólnym szablonem; tu tylko treść. `DeleteStockListDialog.confirm({ list })`
 * zwraca Promise<boolean>. Samo usuwanie robi wywołujący (okno list towaru).
 */
import { MODULE_ID } from "../constants.js";
import { ConfirmDialog } from "./confirm-dialog.js";

export class DeleteStockListDialog extends ConfirmDialog {
  constructor({ list, ...options } = {}) {
    super({ id: `${MODULE_ID}-delete-list-${list.id}`, ...options });
    this.list = list;
  }

  static DEFAULT_OPTIONS = {
    window: { title: "PF2E_SHOP.StockLists.DeleteTitle" }
  };

  async _prepareContext() {
    const t = (key, data) => (data ? game.i18n.format(`PF2E_SHOP.StockLists.${key}`, data) : game.i18n.localize(`PF2E_SHOP.StockLists.${key}`));
    const facts = [{ icon: "fa-scroll", text: t("DeleteEntries", { count: this.list.entries?.length ?? 0 }) }];
    const guaranteed = this.list.guaranteed ? this.list.guaranteedEntries?.length ?? 0 : 0;
    if (guaranteed) facts.push({ icon: "fa-thumbtack", text: t("DeleteGuaranteed", { count: guaranteed }) });
    facts.push({ icon: "fa-store", text: t("DeleteShops") });
    return {
      label: t("DeleteLabel"),
      name: this.list.name,
      icon: "fa-scroll",
      facts,
      note: t("DeleteIrreversible"),
      cancelLabel: game.i18n.localize("PF2E_SHOP.CategoryConfig.Cancel"),
      confirmLabel: t("DeleteConfirm")
    };
  }
}
