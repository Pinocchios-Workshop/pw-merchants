/**
 * Okno losowania asortymentu (ApplicationV2, tylko MG), w stylu karty sklepu.
 * Pokazuje kategorie, które zostaną wylosowane, i pozwala wybrać tryb:
 * "Zastąp" (domyślnie) albo "Dopisz".
 */
import { TEMPLATES } from "../constants.js";
import { getDrawableCategories, randomizeStock } from "../randomizer.js";
import { getSourceName, categoryRange, rangeText } from "../shop-data.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class RandomizeDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Otwiera okno albo przywołuje już otwarte dla tego sklepu. */
  static open(actor) {
    if (!game.user.isGM) return null;
    if (!getDrawableCategories(actor).length) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Randomize.NothingToDraw"));
      return null;
    }
    const id = `pf2e-shop-randomize-${actor.id}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront();
    const app = new this({ id, actor });
    app.render({ force: true });
    return app;
  }

  constructor({ actor, ...options } = {}) {
    super(options);
    this.actor = actor;
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-randomize-window"],
    window: { title: "PF2E_SHOP.Randomize.Title", icon: "fa-solid fa-dice", resizable: false },
    position: { width: 480, height: "auto" },
    form: { handler: RandomizeDialog.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: { cancel: RandomizeDialog.#onCancel }
  };

  static PARTS = {
    form: { template: TEMPLATES.randomize }
  };

  async _prepareContext(options) {
    const missing = game.i18n.localize("PF2E_SHOP.Category.TableMissing");
    const categories = getDrawableCategories(this.actor).map((c, i) => ({
      id: c.id,
      name: c.name,
      // Kilka tabel: nazwy po przecinku, a zakres to suma zakresów wszystkich tabel kategorii.
      table: c.tables.map((t) => getSourceName(t) ?? missing).join(", "),
      range: rangeText(categoryRange(c).min, categoryRange(c).max),
      odd: i % 2 === 1
    }));
    return { shopName: this.actor.name, categories, count: categories.length };
  }

  /** Wybór kategorii: checkbox "wszystkie" w nagłówku, licznik i blokada przycisku przy pustym wyborze. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    const all = el.querySelector("[data-select-all]");
    const boxes = [...el.querySelectorAll("[data-category-check]")];
    const counter = el.querySelector("[data-selected-count]");
    const none = el.querySelector("[data-none-selected]");
    const submit = el.querySelector("button[type=submit]");

    const refresh = () => {
      const selected = boxes.filter((b) => b.checked).length;
      if (counter) counter.textContent = `${selected}/${boxes.length}`;
      if (all) {
        all.checked = selected === boxes.length;
        all.indeterminate = selected > 0 && selected < boxes.length;
      }
      if (none) none.hidden = selected > 0;
      if (submit) submit.disabled = selected === 0;
    };
    all?.addEventListener("change", () => {
      for (const box of boxes) box.checked = all.checked;
      refresh();
    });
    for (const box of boxes) box.addEventListener("change", refresh);
    refresh();
  }

  static async #onSubmit(event, form, formData) {
    const mode = formData.object.mode === "add" ? "add" : "replace";
    const categoryIds = [...form.querySelectorAll("[data-category-check]:checked")].map((b) => b.value);
    if (!categoryIds.length) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Randomize.NoneSelected"));
      return;
    }
    const button = form.querySelector("button[type=submit]");
    if (button) button.disabled = true;

    const summary = await randomizeStock(this.actor, { mode, categoryIds });
    ui.notifications.info(game.i18n.format("PF2E_SHOP.Randomize.Done", {
      created: summary.created,
      stacked: summary.stacked,
      categories: summary.categories
    }));
    if (summary.missingTables.length) {
      ui.notifications.warn(game.i18n.format("PF2E_SHOP.Randomize.MissingTables", { names: summary.missingTables.join(", ") }));
    }
    await this.close();
  }

  static #onCancel() {
    this.close();
  }
}

/** Zachowane dla wywołań z karty sklepu. */
export function openRandomizeDialog(actor) {
  return RandomizeDialog.open(actor);
}
