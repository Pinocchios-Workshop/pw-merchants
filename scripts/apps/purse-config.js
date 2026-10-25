/**
 * Okno edycji kasy sklepu (ApplicationV2, tylko MG).
 *
 * MG wpisuje liczbę monet gp/sp/cp (bez platyny). Przy zapisie kwota jest
 * rozkładana na nominały (25 sp -> 2 gp 5 sp), a różnice są dodawane
 * i odejmowane funkcjami PF2e, więc monety zostają zwykłymi monetami w ekwipunku.
 */
import { TEMPLATES } from "../constants.js";
import { setPurse, makeCoins, formatCopper, normalizePurse, purseCopper, PURSE_DENOMINATIONS } from "../shop-data.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PurseConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static open({ actor }) {
    if (!game.user.isGM) return null;
    const id = `pf2e-shop-purse-${actor.id}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront();
    const app = new this({ id, actor });
    app.render({ force: true });
    return app;
  }

  constructor({ actor, ...options } = {}) {
    super(options);
    this.actor = actor;
    /** Szkic kasy; zapisywany dopiero przy „Zapisz”. */
    this.draft = makeCoins(normalizePurse(purseCopper(actor)));
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-purse-window"],
    window: { icon: "fa-solid fa-coins", resizable: false },
    position: { width: 420, height: "auto" },
    form: { handler: PurseConfig.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: {
      cancel: PurseConfig.#onCancel,
      clear: PurseConfig.#onClear
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.purseConfig }
  };

  get title() {
    return game.i18n.format("PF2E_SHOP.PurseConfig.Title", { name: this.actor.name });
  }

  async _prepareContext() {
    return {
      coins: PURSE_DENOMINATIONS.map((d) => ({ denomination: d, value: this.draft[d] })),
      total: formatCopper(this.draft.copperValue)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const total = this.element.querySelector("[data-purse-total]");
    for (const input of this.element.querySelectorAll("[data-coin]")) {
      input.addEventListener("input", () => {
        this.draft = makeCoins({ ...this.draft, [input.dataset.coin]: input.value });
        if (total) total.textContent = formatCopper(this.draft.copperValue);
      });
    }
  }

  static async #onSubmit() {
    await setPurse(this.actor, this.draft);
    await this.close();
  }

  static #onCancel() {
    this.close();
  }

  /** „Wyczyść”: wszystkie nominały na 0 (zapis dopiero po „Zapisz”). */
  static #onClear() {
    this.draft = makeCoins({});
    this.render();
  }
}
