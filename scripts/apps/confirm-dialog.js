/**
 * Wspólne okno potwierdzenia (ApplicationV2) — JEDNA implementacja dla wszystkich okien
 * „Czy na pewno?” modułu (usunięcie kategorii, wyczyszczenie kategorii, usunięcie listy towaru).
 *
 * `Podklasa.confirm(opcje)` otwiera okno i zwraca Promise<boolean>: true, gdy osoba potwierdziła
 * przyciskiem głównym; zamknięcie okna w inny sposób albo „Anuluj” = false. Samą zmianę robi
 * wywołujący. Podklasa podaje szablon (PARTS) i dane (`_prepareContext`).
 *
 * Gotowy szablon `templates/confirm-delete.hbs` przyjmuje:
 * { label, name, icon, facts: [{ icon, text }], note, warning, confirmLabel, cancelLabel }.
 */
import { TEMPLATES } from "../constants.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ConfirmDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Otwiera okno; Promise z odpowiedzią (true = potwierdzono). */
  static confirm(options = {}) {
    return new Promise((resolve) => {
      const app = new this({ ...options, resolve });
      app.render({ force: true });
    });
  }

  constructor({ resolve, ...options } = {}) {
    super(options);
    this.#resolve = resolve;
  }

  #resolve;

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-delete-window"],
    window: { icon: "fa-solid fa-trash", resizable: false },
    position: { width: 420, height: "auto" },
    form: { handler: ConfirmDialog.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: { cancel: ConfirmDialog.#onCancel }
  };

  static PARTS = {
    form: { template: TEMPLATES.confirmDelete }
  };

  /** Zamknięcie okna w inny sposób niż przyciskiem głównym = brak zgody. */
  _onClose(options) {
    super._onClose(options);
    this.#settle(false);
  }

  #settle(value) {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(value);
  }

  static async #onSubmit() {
    this.#settle(true);
    await this.close();
  }

  static #onCancel() {
    this.close();
  }
}
