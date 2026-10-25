/**
 * Okno zakupu (gracz): wybór ilości i postaci, podgląd kosztu i pieniędzy.
 * „Kup” wysyła prośbę o zakup (wykonuje ją klient MG, patrz purchase.js).
 */
import { TEMPLATES } from "../constants.js";
import { formatCopper, formatPrice, itemModifier } from "../shop-data.js";
import { purchaseCost, fundsCopper, buyerCandidates, requestPurchase } from "../purchase.js";
import { isUntypedAmmo, ammoTypeChoices } from "../ammo.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PurchaseDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static open({ shop, itemId }) {
    const item = shop?.items?.get(itemId);
    if (!item) return null;
    if ((item.quantity ?? 0) < 1) {
      ui.notifications.warn(game.i18n.format("PF2E_SHOP.Purchase.Error.SoldOut", { item: item.name }));
      return null;
    }
    const buyers = buyerCandidates();
    if (!buyers.length) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Purchase.Error.NoCharacter"));
      return null;
    }
    const id = `pf2e-shop-buy-${shop.id}-${item.id}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront();
    const app = new this({ id, shop, item, buyers });
    app.render({ force: true });
    return app;
  }

  constructor({ shop, item, buyers, ...options } = {}) {
    super(options);
    this.shop = shop;
    this.item = item;
    this.buyers = buyers;
    this.draft = { quantity: 1, buyerId: buyers[0].id, ammoType: null };
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-purchase-window"],
    window: { icon: "fa-solid fa-cart-shopping", resizable: false },
    position: { width: 440, height: "auto" },
    form: { handler: PurchaseDialog.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: {
      cancel: PurchaseDialog.#onCancel,
      less: PurchaseDialog.#onLess,
      more: PurchaseDialog.#onMore,
      max: PurchaseDialog.#onMax
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.purchase }
  };

  get title() {
    return game.i18n.format("PF2E_SHOP.Purchase.Title", { name: this.item.name });
  }

  get stock() {
    return this.item.quantity ?? 0;
  }

  get buyer() {
    return this.buyers.find((a) => a.id === this.draft.buyerId) ?? this.buyers[0];
  }

  /** Stan kosztu i pieniędzy dla bieżącego szkicu. */
  #summary() {
    const quantity = Math.min(this.stock, Math.max(1, Math.floor(Number(this.draft.quantity) || 1)));
    const cost = purchaseCost(this.shop, this.item, quantity);
    const funds = fundsCopper(this.buyer);
    return { quantity, cost, funds, enough: funds >= cost };
  }

  /**
   * Typy amunicji do wyboru (amunicja specjalna bez typu; inaczej pusta lista): jedna lista
   * alfabetycznie. Domyślnie typ do broni kupującego, a gdy go nie ma — pierwszy.
   */
  #ammoOptions() {
    if (!isUntypedAmmo(this.item)) return [];
    const choices = ammoTypeChoices(this.item, this.buyer);
    if (!choices.some((c) => c.value === this.draft.ammoType)) {
      this.draft.ammoType = (choices.find((c) => c.own) ?? choices[0])?.value ?? null;
    }
    return choices.map((c) => ({ ...c, selected: c.value === this.draft.ammoType }));
  }

  async _prepareContext() {
    const { quantity, cost, funds, enough } = this.#summary();
    const ammoOptions = this.#ammoOptions();
    return {
      ammoOptions,
      chooseAmmo: ammoOptions.length > 0,
      name: this.item.name,
      img: this.item.img,
      level: this.item.level ?? 0,
      unitPrice: formatPrice(this.item, itemModifier(this.shop, this.item)),
      stock: this.stock,
      quantity,
      buyers: this.buyers.map((a) => ({ id: a.id, name: a.name, selected: a.id === this.buyer.id })),
      multipleBuyers: this.buyers.length > 1,
      buyerName: this.buyer.name,
      total: formatCopper(cost),
      funds: formatCopper(funds),
      enough
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    const input = el.querySelector("[name=quantity]");
    input?.addEventListener("input", () => {
      this.draft.quantity = input.value;
      this.#refresh();
    });
    input?.addEventListener("change", () => {
      input.value = this.#summary().quantity;
    });
    el.querySelector("[name=buyer]")?.addEventListener("change", (event) => {
      this.draft.buyerId = event.currentTarget.value;
      // Inna postać = inny domyślny typ amunicji (do jej broni), o ile gracz go nie zmienił.
      if (isUntypedAmmo(this.item) && !this.ammoTouched) {
        this.draft.ammoType = null;
        this.render();
      }
      else this.#refresh();
    });
    el.querySelector("[name=ammoType]")?.addEventListener("change", (event) => {
      this.draft.ammoType = event.currentTarget.value;
      this.ammoTouched = true;
    });
  }

  /** Odświeża koszt i pieniądze bez przerysowania okna (żeby nie gubić fokusu). */
  #refresh() {
    const { cost, funds, enough } = this.#summary();
    const el = this.element;
    el.querySelector("[data-total]").textContent = formatCopper(cost);
    el.querySelector("[data-funds]").textContent = formatCopper(funds);
    el.querySelector("[data-not-enough]").hidden = enough;
    el.querySelector("[data-total]").classList.toggle("psm-price-value--bad", !enough);
    el.querySelector("[type=submit]").disabled = !enough;
  }

  #setQuantity(value) {
    this.draft.quantity = Math.min(this.stock, Math.max(1, value));
    const input = this.element.querySelector("[name=quantity]");
    if (input) input.value = this.draft.quantity;
    this.#refresh();
  }

  static #onLess() {
    this.#setQuantity(this.#summary().quantity - 1);
  }

  static #onMore() {
    this.#setQuantity(this.#summary().quantity + 1);
  }

  static #onMax() {
    this.#setQuantity(this.stock);
  }

  static async #onSubmit() {
    const { quantity, enough } = this.#summary();
    if (!enough) return;
    const ammoType = isUntypedAmmo(this.item) ? this.draft.ammoType : null;
    const sent = await requestPurchase({ shop: this.shop, item: this.item, buyer: this.buyer, quantity, ammoType });
    if (sent) await this.close();
  }

  static #onCancel() {
    this.close();
  }
}
