/**
 * Okno sprzedaży (gracz): ekwipunek postaci po lewej, propozycja po prawej.
 * Po wysłaniu propozycji to samo okno pokazuje kolejne stany: czekanie,
 * kontrofertę MG, sprzedaż zakończoną albo odrzuconą. Zamknięcie okna
 * wycofuje niezakończoną propozycję.
 */
import { windowSize } from "../window-sizes.js";
import { TEMPLATES } from "../constants.js";
import { toggleSummary, restoreSummary } from "./item-summary.js";
import { formatCopper, purseCopper, rarityInfo, coinsText } from "../shop-data.js";
import { buyerCandidates } from "../purchase.js";
import {
  saleCopper, itemValueCopper, isFullValue, sellableItems, unsellableReason,
  sendToGM, onPlayerMessage
} from "../selling.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Kategorie ekwipunku jak na karcie postaci PF2e. */
const GROUPS = [
  { key: "weapon", types: ["weapon"] },
  { key: "armor", types: ["armor", "shield"] },
  { key: "equipment", types: ["equipment", "book"] },
  { key: "consumable", types: ["consumable", "ammo"] },
  { key: "treasure", types: ["treasure"] },
  { key: "backpack", types: ["backpack"] }
];

const ICONS = {
  weapon: "fa-khanda", armor: "fa-shield-halved", equipment: "fa-toolbox",
  consumable: "fa-flask", treasure: "fa-gem", backpack: "fa-bag-shopping"
};

/** Kolor i etykieta rzadkości przedmiotu (wspólna funkcja z shop-data.js). */
export function itemRarity(item) {
  return rarityInfo(item?.rarity ?? "common");
}

export class SellDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static open({ shop }) {
    const sellers = buyerCandidates();
    if (!sellers.length) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Sell.NoCharacter"));
      return null;
    }
    const id = `pf2e-shop-sell-${shop.id}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront();
    const app = new this({ id, shop, sellers });
    app.render({ force: true });
    return app;
  }

  constructor({ shop, sellers, ...options } = {}) {
    // Rozmiar z presetu ekranu (1920 × 1080 / 2560 × 1440), patrz window-sizes.js.
    super(foundry.utils.mergeObject({ position: windowSize("sellDialog") }, options, { inplace: false }));
    this.shop = shop;
    this.sellers = sellers;
    this.sellerId = sellers[0].id;
    this.#reset();
    // Ekwipunek postaci zmienia się w trakcie: odświeżamy listę.
    this._hooks = ["createItem", "updateItem", "deleteItem"].map((hook) => [
      hook,
      Hooks.on(hook, (item) => {
        // Ekwipunek postaci albo kasa sklepu (monety to przedmioty sklepu).
        const parentId = item.parent?.id;
        if ((parentId === this.sellerId || parentId === this.shop.id) && this.phase === "building") this.render();
      })
    ]);
  }

  #reset() {
    this.phase = "building"; // building | waiting | counter | done | rejected (nie „state”: to pole ApplicationV2)
    this.lines = new Map(); // itemId -> quantity
    this.offerId = null;
    this.accepted = null; // kontroferta: Map itemId → przyjęta ilość (null = brak kontroferty)
    this.sold = null; // wynik sprzedaży
    this.search = "";
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    // „actor sheet”: te same style PF2e co karta sklepu (np. wygląd rozwiniętego opisu przedmiotu).
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-sell-window", "actor", "sheet"],
    window: { icon: "fa-solid fa-hand-holding-dollar", resizable: true },
    position: { width: 940, height: 720 },
    form: { handler: SellDialog.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: {
      summary: SellDialog.#onSummary,
      add: SellDialog.#onAdd,
      remove: SellDialog.#onRemove,
      less: SellDialog.#onLess,
      more: SellDialog.#onMore,
      withdraw: SellDialog.#onWithdraw,
      acceptCounter: SellDialog.#onAcceptCounter,
      declineCounter: SellDialog.#onDeclineCounter,
      again: SellDialog.#onAgain
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.sell }
  };

  get title() {
    return game.i18n.format("PF2E_SHOP.Sell.Title", { shop: this.shop.name });
  }

  get seller() {
    return this.sellers.find((a) => a.id === this.sellerId) ?? this.sellers[0];
  }

  /** Linie propozycji z aktualnymi danymi przedmiotów. */
  #offerLines() {
    const lines = [];
    for (const [itemId, quantity] of this.lines) {
      const item = this.seller.items.get(itemId);
      if (!item) continue;
      const qty = Math.min(quantity, item.quantity ?? 0);
      if (qty < 1) continue;
      const price = saleCopper(item, qty);
      // Kontroferta: MG mógł przyjąć mniej sztuk (np. 2 z 3); cena liczona od przyjętej ilości.
      const acceptedQuantity = this.accepted ? Math.min(qty, this.accepted.get(itemId) ?? 0) : qty;
      const acceptedPrice = saleCopper(item, acceptedQuantity);
      lines.push({
        id: itemId, name: item.name, img: item.img, quantity: qty, max: item.quantity ?? 0, atMax: qty >= (item.quantity ?? 0),
        price, priceText: formatCopper(price), full: isFullValue(item),
        accepted: acceptedQuantity > 0, acceptedQuantity, partial: acceptedQuantity > 0 && acceptedQuantity < qty,
        acceptedPriceText: formatCopper(acceptedPrice), acceptedPrice,
        value: itemValueCopper(item, qty)
      });
    }
    return lines;
  }

  async _prepareContext() {
    const seller = this.seller;
    const lines = this.#offerLines();
    const needle = this.search.trim().toLocaleLowerCase();

    const items = sellableItems(seller);
    const groups = GROUPS.map((group) => {
      const rows = items
        .filter((i) => group.types.includes(i.type))
        .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
        .map((item, index) => {
          const inOffer = this.lines.get(item.id) ?? 0;
          const price = item.system?.price;
          const per = Math.max(1, price?.per ?? 1);
          return {
            id: item.id,
            name: item.name,
            img: item.img,
            icon: ICONS[group.key],
            quantity: item.quantity ?? 0,
            value: `${price?.value?.toString?.() ?? ""}${per > 1 ? ` / ${per}` : ""}`,
            equipped: !!item.isEquipped,
            inOffer,
            offerAll: inOffer > 0 && inOffer >= (item.quantity ?? 0),
            reason: unsellableReason(item),
            hidden: !!needle && !item.name.toLocaleLowerCase().includes(needle),
            odd: index % 2 === 1,
            full: isFullValue(item),
            ...itemRarity(item)
          };
        });
      return { key: group.key, label: game.i18n.localize(`PF2E_SHOP.Sell.Group.${group.key}`), rows, count: rows.length };
    }).filter((g) => g.count);

    // Pozostałe typy (np. kit) trafiają do „Ekwipunek”, jeśli takie są.
    const known = GROUPS.flatMap((g) => g.types);
    const other = items.filter((i) => !known.includes(i.type));
    if (other.length) {
      groups.push({
        key: "other", label: game.i18n.localize("PF2E_SHOP.Sell.Group.other"), count: other.length,
        rows: other.map((item, index) => ({
          id: item.id, name: item.name, img: item.img, icon: "fa-box", quantity: item.quantity ?? 0,
          value: item.system?.price?.value?.toString?.() ?? "", inOffer: this.lines.get(item.id) ?? 0,
          reason: unsellableReason(item), odd: index % 2 === 1, ...itemRarity(item),
          hidden: !!needle && !item.name.toLocaleLowerCase().includes(needle)
        }))
      });
    }

    const accepted = lines.filter((l) => l.accepted);
    const totalCp = lines.reduce((sum, l) => sum + l.price, 0);
    const shopPurse = purseCopper(this.shop);
    const tooExpensive = totalCp > shopPurse;
    const coins = seller.inventory?.currency ?? {};
    return {
      state: this.phase,
      building: this.phase === "building",
      waiting: this.phase === "waiting",
      counter: this.phase === "counter",
      done: this.phase === "done",
      rejected: this.phase === "rejected",
      seller: {
        name: seller.name,
        img: seller.img,
        level: seller.level ?? seller.system?.details?.level?.value ?? 0,
        className: seller.class?.name ?? "",
        ancestry: seller.ancestry?.name ?? "",
        money: coinsText(coins)
      },
      sellers: this.sellers.map((a) => ({ id: a.id, name: a.name, selected: a.id === seller.id })),
      multipleSellers: this.sellers.length > 1 && this.phase === "building" && !this.lines.size,
      search: this.search,
      groups,
      lines,
      count: lines.length,
      total: formatCopper(totalCp),
      shopPurse: formatCopper(shopPurse),
      tooExpensive,
      canSend: lines.length > 0 && !tooExpensive,
      totalValue: formatCopper(lines.reduce((s, l) => s + l.value, 0)),
      acceptedTotal: formatCopper(accepted.reduce((s, l) => s + l.acceptedPrice, 0)),
      soldTotal: this.sold ? formatCopper(this.sold.reduce((s, l) => s + l.price, 0)) : "",
      soldLines: (this.sold ?? []).map((l) => ({ ...l, priceText: formatCopper(l.price) }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    await restoreSummary(el, this.openSummary, { actor: this.seller });
    const search = el.querySelector("[data-sell-search]");
    search?.addEventListener("input", () => {
      this.search = search.value;
      const needle = this.search.trim().toLocaleLowerCase();
      for (const row of el.querySelectorAll("[data-sell-row]")) {
        row.hidden = !!needle && !row.dataset.name.toLocaleLowerCase().includes(needle);
      }
    });
    el.querySelector("[name=seller]")?.addEventListener("change", (event) => {
      this.sellerId = event.currentTarget.value;
      this.lines.clear();
      this.render();
    });
  }

  /* ---------------- Akcje: budowanie propozycji ---------------- */

  #itemIdOf(target) {
    return target.closest("[data-item-id]")?.dataset.itemId;
  }

  /** Kliknięcie nazwy: opis przedmiotu jak na karcie sklepu. */
  static async #onSummary(event, target) {
    this.openSummary = await toggleSummary(target.closest("[data-item-id]"), { actor: this.seller });
  }

  static #onAdd(event, target) {
    const itemId = this.#itemIdOf(target);
    const item = this.seller.items.get(itemId);
    if (!item || unsellableReason(item)) return;
    // Dodanie: cała ilość (łatwo zmniejszyć −); ponowne kliknięcie usuwa z propozycji.
    if (this.lines.has(itemId)) this.lines.delete(itemId);
    else this.lines.set(itemId, item.quantity ?? 1);
    this.render();
  }

  static #onRemove(event, target) {
    this.lines.delete(this.#itemIdOf(target));
    this.render();
  }

  static #onLess(event, target) {
    const itemId = this.#itemIdOf(target);
    const qty = (this.lines.get(itemId) ?? 1) - 1;
    if (qty < 1) this.lines.delete(itemId);
    else this.lines.set(itemId, qty);
    this.render();
  }

  static #onMore(event, target) {
    const itemId = this.#itemIdOf(target);
    const max = this.seller.items.get(itemId)?.quantity ?? 1;
    this.lines.set(itemId, Math.min(max, (this.lines.get(itemId) ?? 0) + 1));
    this.render();
  }

  /** „Zaproponuj sprzedaż”. */
  static #onSubmit() {
    if (this.phase !== "building") return;
    const lines = this.#offerLines();
    if (!lines.length) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Sell.EmptyOffer"));
      return;
    }
    // Sklep musi mieć tyle pieniędzy, ile wynosi propozycja.
    const total = lines.reduce((sum, l) => sum + l.price, 0);
    if (total > purseCopper(this.shop)) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Sell.ShopTooPoor"));
      return;
    }
    this.offerId = foundry.utils.randomID();
    this.offerNames = Object.fromEntries(lines.map((l) => [l.id, l.name]));
    const sent = sendToGM({
      action: "sell-offer",
      offerId: this.offerId,
      shopUuid: this.shop.uuid,
      sellerUuid: this.seller.uuid,
      items: lines.map((l) => ({ itemId: l.id, quantity: l.quantity, name: l.name }))
    });
    if (!sent) {
      this.offerId = null;
      return;
    }
    onPlayerMessage(this.offerId, (data) => this.#onAnswer(data));
    this.phase = "waiting";
    this.render();
  }

  /* ---------------- Odpowiedzi MG ---------------- */

  #onAnswer(data) {
    if (data.action === "sell-counter") {
      // Przyjęte przedmioty z ilościami; starszy format: same id = cała ilość.
      this.accepted = Array.isArray(data.accepted)
        ? new Map(data.accepted.map((a) => [a.itemId, Number(a.quantity) || 0]))
        : new Map((data.acceptedIds ?? []).map((id) => [id, Infinity]));
      this.phase = "counter";
    } else if (data.action === "sell-result") {
      onPlayerMessage(this.offerId, null);
      if (data.status === "done") {
        this.sold = (data.sold ?? []).map((s) => ({ ...s, name: this.offerNames?.[s.itemId] ?? "?" }));
        this.phase = "done";
        ui.notifications.info(game.i18n.format(data.message, data.data ?? {}));
      } else if (data.status === "rejected") {
        this.phase = "rejected";
      } else {
        ui.notifications.warn(game.i18n.format(data.message ?? "PF2E_SHOP.Sell.Error.Unknown", data.data ?? {}));
        this.phase = "building";
        this.offerId = null;
        this.accepted = null;
      }
    }
    this.render();
  }

  static #onWithdraw() {
    this.#cancelOffer();
    this.#reset();
    this.render();
  }

  static #onAcceptCounter() {
    if (this.phase !== "counter") return;
    sendToGM({ action: "sell-accept", offerId: this.offerId });
    this.phase = "waiting";
    this.render();
  }

  static #onDeclineCounter() {
    if (this.phase !== "counter") return;
    sendToGM({ action: "sell-decline", offerId: this.offerId });
    onPlayerMessage(this.offerId, null);
    this.phase = "rejected";
    this.render();
  }

  static #onAgain() {
    this.#reset();
    this.render();
  }

  /** Wycofanie propozycji, która jeszcze czeka na MG albo na odpowiedź gracza. */
  #cancelOffer() {
    if (!this.offerId || !["waiting", "counter"].includes(this.phase)) return;
    sendToGM({ action: "sell-cancel", offerId: this.offerId });
    onPlayerMessage(this.offerId, null);
  }

  _onClose(options) {
    this.#cancelOffer();
    for (const [hook, id] of this._hooks ?? []) Hooks.off(hook, id);
    super._onClose?.(options);
  }
}

