/**
 * Okno MG z propozycją sprzedaży gracza. Otwiera się samo u aktywnego MG.
 * MG zaznacza przedmioty, które sklepikarz przyjmie, i może przyjąć tylko część
 * sztuk (np. 2 z 3 szmaragdów) — cena jest stała, liczona od przyjętej ilości:
 * „Kup” (wszystko w pełnej ilości), „Kontroferta” (część odznaczona albo
 * mniej sztuk) albo „Odrzuć całość”. Zamknięcie okna bez decyzji odrzuca propozycję.
 */
import { windowSize } from "../window-sizes.js";
import { TEMPLATES } from "../constants.js";
import { toggleSummary, restoreSummary } from "./item-summary.js";
import { itemRarity } from "./sell-dialog.js";
import { formatCopper, purseCopper, normalizePurse, coinsText } from "../shop-data.js";
import {
  saleCopper, itemValueCopper, isFullValue, executeSale, sendToPlayer, onGMMessage
} from "../selling.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SellReview extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Wywoływane po otrzymaniu propozycji przez socket. */
  static async openFromOffer(offer) {
    const shop = await fromUuid(offer.shopUuid);
    const seller = await fromUuid(offer.sellerUuid);
    if (!shop || !seller) return;
    const app = new this({ id: `pf2e-shop-sell-review-${offer.offerId}`, offer, shop, seller });
    await app.render({ force: true });
    const user = game.users.get(offer.userId);
    ui.notifications.info(game.i18n.format("PF2E_SHOP.SellReview.Incoming", { seller: seller.name, user: user?.name ?? "", shop: shop.name }));
    return app;
  }

  constructor({ offer, shop, seller, ...options } = {}) {
    // Rozmiar z presetu ekranu (1920 × 1080 / 2560 × 1440), patrz window-sizes.js.
    super(foundry.utils.mergeObject({ position: windowSize("sellReview") }, options, { inplace: false }));
    this.offer = offer;
    this.shop = shop;
    this.seller = seller;
    /** Ile sztuk każdego przedmiotu sklepikarz przyjmuje (0 = odznaczony). */
    this.amounts = new Map(offer.items.map((l) => [l.itemId, l.quantity]));
    this.phase = "deciding"; // deciding | waiting
    this.finished = false;
    onGMMessage(offer.offerId, (data) => this.#onPlayer(data));
  }

  static DEFAULT_OPTIONS = {
    tag: "div",
    // „actor sheet”: te same style PF2e co karta sklepu (np. wygląd rozwiniętego opisu przedmiotu).
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-sell-window", "psm-sell-review-window", "actor", "sheet"],
    window: { icon: "fa-solid fa-scale-balanced", resizable: true },
    position: { width: 1000, height: 560 },
    actions: {
      summary: SellReview.#onSummary,
      less: SellReview.#onLess,
      more: SellReview.#onMore,
      openShop: SellReview.#onOpenShop,
      reject: SellReview.#onReject,
      decide: SellReview.#onDecide
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.sellReview }
  };

  get title() {
    return game.i18n.format("PF2E_SHOP.SellReview.Title", { seller: this.seller.name, shop: this.shop.name });
  }

  #lines() {
    return this.offer.items.map((line, index) => {
      const item = this.seller.items.get(line.itemId);
      const amount = Math.min(this.amounts.get(line.itemId) ?? 0, line.quantity);
      const price = item ? saleCopper(item, amount) : 0;
      const bookPrice = item?.system?.price;
      return {
        id: line.itemId,
        name: item?.name ?? line.name,
        img: item?.img,
        missing: !item,
        level: item?.level ?? 0,
        quantity: line.quantity,
        amount,
        partial: amount > 0 && amount < line.quantity,
        canLess: amount > 0,
        canMore: amount < line.quantity,
        many: line.quantity > 1,
        value: formatCopper(item ? itemValueCopper(item, line.quantity) : 0),
        unitValue: bookPrice?.value?.toString?.() ?? "",
        price,
        fullPrice: item ? saleCopper(item, line.quantity) : 0,
        // Odznaczony przedmiot: cena za całą zaproponowaną ilość, przekreślona (jak wcześniej).
        priceText: formatCopper(amount > 0 ? price : (item ? saleCopper(item, line.quantity) : 0)),
        full: item ? isFullValue(item) : false,
        checked: amount > 0,
        odd: index % 2 === 1,
        ...(item ? itemRarity(item) : {})
      };
    });
  }

  /** Przyjęte przedmioty i ilości: [{ itemId, quantity }]. */
  #accepted() {
    return this.offer.items
      .map((l) => ({ itemId: l.itemId, quantity: Math.min(this.amounts.get(l.itemId) ?? 0, l.quantity) }))
      .filter((l) => l.quantity > 0);
  }

  async _prepareContext() {
    const lines = this.#lines();
    const checked = lines.filter((l) => l.checked && !l.missing);
    const total = lines.reduce((s, l) => s + l.fullPrice, 0);
    const chosen = checked.reduce((s, l) => s + l.price, 0);
    const purse = purseCopper(this.shop);
    const after = purse - chosen;
    // „Kup” tylko wtedy, gdy wszystko jest przyjęte w pełnej ilości.
    const all = lines.every((l) => !l.missing && l.amount === l.quantity);
    const user = game.users.get(this.offer.userId);
    const p = normalizePurse(purse);
    return {
      waiting: this.phase === "waiting",
      seller: {
        name: this.seller.name,
        img: this.seller.img,
        level: this.seller.level ?? 0,
        className: this.seller.class?.name ?? "",
        ancestry: this.seller.ancestry?.name ?? "",
        user: user?.name ?? "",
        purse: coinsText(this.seller.inventory?.currency)
      },
      shop: { name: this.shop.name, img: this.shop.img },
      purse: `${p.gp} gp · ${p.sp} sp · ${p.cp} cp`,
      lines,
      count: lines.length,
      checkedCount: checked.length,
      total: formatCopper(total),
      chosen: formatCopper(chosen),
      after: after >= 0 ? formatCopper(after) : `−${formatCopper(-after)}`,
      notEnough: after < 0,
      all,
      none: checked.length === 0,
      decideDisabled: checked.length === 0 || after < 0
    };
  }

  /* ---------------- Akcje ---------------- */

  #itemIdOf(target) {
    return target.closest("[data-item-id]")?.dataset.itemId;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    // Pola wyboru: które przedmioty sklepikarz przyjmie.
    // Pole wyboru: zaznaczenie przyjmuje całą zaproponowaną ilość, odznaczenie nic.
    for (const input of this.element.querySelectorAll("[data-keep]")) {
      input.addEventListener("change", () => {
        if (this.phase !== "deciding") return;
        const itemId = input.closest("[data-item-id]")?.dataset.itemId;
        const offered = this.offer.items.find((l) => l.itemId === itemId)?.quantity ?? 0;
        this.amounts.set(itemId, input.checked ? offered : 0);
        this.render();
      });
    }
    await restoreSummary(this.element, this.openSummary, { actor: this.seller });
  }

  /** Kliknięcie nazwy: opis przedmiotu jak na karcie sklepu. */
  static async #onSummary(event, target) {
    this.openSummary = await toggleSummary(target.closest("[data-item-id]"), { actor: this.seller });
  }

  /** Nazwa sklepu w nagłówku: otwiera kartę sklepu, którego dotyczy propozycja. */
  static #onOpenShop() {
    this.shop.sheet?.render(true);
  }

  /** „−” / „+” przy ilości: ile sztuk sklepikarz przyjmuje (0 = odznaczony). */
  static #onLess(event, target) {
    this.#step(target, -1);
  }

  static #onMore(event, target) {
    this.#step(target, 1);
  }

  #step(target, delta) {
    if (this.phase !== "deciding") return;
    const itemId = this.#itemIdOf(target);
    const offered = this.offer.items.find((l) => l.itemId === itemId)?.quantity ?? 0;
    const amount = Math.max(0, Math.min(offered, (this.amounts.get(itemId) ?? 0) + delta));
    this.amounts.set(itemId, amount);
    this.render();
  }

  static async #onReject() {
    this.#finish({ action: "sell-result", status: "rejected" });
    ui.notifications.info(game.i18n.format("PF2E_SHOP.SellReview.Rejected", { seller: this.seller.name }));
    await this.close();
  }

  /** „Kup” (wszystko w pełnej ilości) albo „Kontroferta” (część odznaczona albo mniej sztuk). */
  static async #onDecide() {
    if (this.phase !== "deciding") return;
    const accepted = this.#accepted();
    if (!accepted.length) return;
    const full = this.offer.items.every((l) => accepted.some((a) => a.itemId === l.itemId && a.quantity === l.quantity));
    if (full) return this.#sell(accepted);
    this.accepted = accepted;
    this.phase = "waiting";
    sendToPlayer(this.offer.userId, {
      action: "sell-counter", offerId: this.offer.offerId, accepted, acceptedIds: accepted.map((a) => a.itemId)
    });
    this.render();
  }

  /** @param {{itemId: string, quantity: number}[]} accepted */
  async #sell(accepted) {
    const result = await executeSale(this.offer, accepted);
    this.#finish({ action: "sell-result", status: result.ok ? "done" : "error", ...result });
    if (result.ok) ui.notifications.info(game.i18n.format("PF2E_SHOP.SellReview.Sold", { seller: this.seller.name, price: result.data.price }));
    else ui.notifications.warn(game.i18n.format(result.message, result.data ?? {}));
    await this.close();
  }

  /** Odpowiedzi gracza: akceptacja / odrzucenie kontroferty, wycofanie. */
  async #onPlayer(data) {
    if (data.action === "sell-accept" && this.phase === "waiting") return this.#sell(this.accepted);
    if (data.action === "sell-decline") {
      this.#finish(null);
      ui.notifications.info(game.i18n.format("PF2E_SHOP.SellReview.Declined", { seller: this.seller.name }));
      return this.close();
    }
    if (data.action === "sell-cancel") {
      this.#finish(null);
      ui.notifications.info(game.i18n.format("PF2E_SHOP.SellReview.Cancelled", { seller: this.seller.name }));
      return this.close();
    }
  }

  /** Kończy rozmowę: wysyła wynik graczowi (jeśli jest) i przestaje słuchać. */
  #finish(message) {
    if (this.finished) return;
    this.finished = true;
    onGMMessage(this.offer.offerId, null);
    if (message) sendToPlayer(this.offer.userId, { ...message, offerId: this.offer.offerId });
  }

  _onClose(options) {
    // Zamknięcie okna bez decyzji = odrzucenie propozycji.
    this.#finish({ action: "sell-result", status: "rejected" });
    super._onClose?.(options);
  }
}
