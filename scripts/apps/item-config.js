/**
 * Okno ustawień przedmiotu w sklepie (ApplicationV2, tylko MG).
 *
 * Na razie jedna opcja: własna cena bazowa przedmiotu. Mnożnik sklepu nadal
 * działa na nią tak samo jak na cenę z podręcznika. Zmiany są w szkicu do
 * kliknięcia „Zapisz”, więc „Anuluj” niczego nie zmienia. Okno jest pomyślane
 * tak, żeby dało się w nim dopisywać kolejne opcje przedmiotu.
 */
import { TEMPLATES } from "../constants.js";
import {
  itemModifier, isBuyback, getCustomPrice, setCustomPrice, bookPrice, makeCoins,
  modifiedPackCopper, formatCopper, formatIn, unitDenomination
} from "../shop-data.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Nominały ceny własnej: bez platyny (cenę w pp zapisujemy w gp). */
const DENOMINATIONS = ["gp", "sp", "cp"];
const RATES = { gp: 100, sp: 10, cp: 1 };

/**
 * Kwota w jednej walucie (na razie cena ma tylko jeden nominał).
 * Zostawia jedyny wpisany nominał; mieszaną kwotę („1 gp 5 sp”) zamienia na
 * największy nominał, który ją dokładnie wyraża („15 sp”). Platyna zamienia się na gp.
 */
function singleCurrency(coins) {
  const c = makeCoins(coins);
  const used = ["pp", ...DENOMINATIONS].filter((d) => c[d] > 0);
  if (used.length <= 1 && !c.pp) return c;
  const copper = c.copperValue;
  const unit = ["gp", "sp", "cp"].find((d) => copper % RATES[d] === 0) ?? "cp";
  return makeCoins({ [unit]: copper / RATES[unit] });
}

export class ItemConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Otwiera okno albo przywołuje już otwarte dla tego przedmiotu. */
  static open({ actor, itemId }) {
    if (!game.user.isGM) return null;
    const item = actor?.items.get(itemId);
    if (!item) return null;
    const id = `pf2e-shop-item-${actor.id}-${item.id}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront();
    const app = new this({ id, actor, item });
    app.render({ force: true });
    return app;
  }

  constructor({ actor, item, ...options } = {}) {
    super(options);
    this.actor = actor;
    this.item = item;
    const custom = getCustomPrice(item);
    const book = bookPrice(item)?.value ?? {};
    /** Szkic ustawień; zapisywany dopiero przy „Zapisz”. */
    this.draft = {
      useCustom: !!custom,
      // Bez własnej ceny pola startują od ceny z podręcznika, żeby łatwo ją poprawić.
      coins: singleCurrency(custom ?? book)
    };
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-item-window"],
    window: { icon: "fa-solid fa-gear", resizable: false },
    position: { width: 460, height: "auto" },
    form: { handler: ItemConfig.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: {
      cancel: ItemConfig.#onCancel,
      useBookPrice: ItemConfig.#onUseBookPrice
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.itemConfig }
  };

  get title() {
    return game.i18n.format("PF2E_SHOP.ItemConfig.Title", { name: this.item.name });
  }

  /** Cena paczki w sklepie (z mnożnikiem) dla podanej ceny bazowej. */
  #shopPrice(coins) {
    const priceModifier = itemModifier(this.actor, this.item);
    const per = Math.max(1, bookPrice(this.item)?.per ?? 1);
    const copper = modifiedPackCopper({ value: makeCoins(coins), per }, priceModifier);
    // Przy własnej cenie wynik zostaje w wybranej walucie („14 sp”, nie „1 gp 4 sp”).
    const text = this.draft.useCustom ? formatIn(copper, unitDenomination(coins)) : formatCopper(copper);
    return per > 1 ? `${text} / ${per}` : text;
  }

  async _prepareContext(options) {
    const book = bookPrice(this.item);
    const per = Math.max(1, book?.per ?? 1);
    const priceModifier = itemModifier(this.actor, this.item);
    const base = this.draft.useCustom ? this.draft.coins : makeCoins(book?.value);
    return {
      name: this.item.name,
      img: this.item.img,
      level: this.item.level ?? 0,
      bookPrice: `${formatCopper(makeCoins(book?.value).copperValue)}${per > 1 ? ` / ${per}` : ""}`,
      per,
      showPer: per > 1,
      useCustom: this.draft.useCustom,
      coins: DENOMINATIONS.map((d) => ({ denomination: d, value: this.draft.coins[d] })),
      modifierPercent: Math.round(priceModifier * 100),
      buyback: isBuyback(this.item),
      shopPrice: this.#shopPrice(base)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;
    const preview = el.querySelector("[data-shop-price]");
    const toggle = el.querySelector("[name=useCustom]");
    const inputs = [...el.querySelectorAll("[data-coin]")];

    const refresh = () => {
      for (const input of inputs) input.disabled = !this.draft.useCustom;
      el.querySelector(".psm-price-editor")?.classList.toggle("psm-price-editor--off", !this.draft.useCustom);
      const useBook = el.querySelector("[data-action=useBookPrice]");
      if (useBook) useBook.disabled = !this.draft.useCustom;
      const base = this.draft.useCustom ? this.draft.coins : makeCoins(bookPrice(this.item)?.value);
      if (preview) preview.textContent = this.#shopPrice(base);
    };

    toggle?.addEventListener("change", () => {
      this.draft.useCustom = toggle.checked;
      refresh();
      if (toggle.checked) inputs.find((i) => i.dataset.coin === "gp")?.focus();
    });
    // Jedna waluta naraz: wpisanie kwoty w jednym nominale czyści pozostałe.
    for (const input of inputs) {
      input.addEventListener("input", () => {
        const denomination = input.dataset.coin;
        const value = Math.max(0, Math.floor(Number(input.value) || 0));
        if (value > 0) {
          for (const other of inputs) if (other !== input) other.value = 0;
          this.draft.coins = makeCoins({ [denomination]: value });
        } else {
          this.draft.coins = makeCoins({ ...this.draft.coins, [denomination]: 0 });
        }
        refresh();
      });
    }
    refresh();
  }

  /* ---------------- Akcje ---------------- */

  static async #onSubmit() {
    await setCustomPrice(this.item, this.draft.useCustom ? this.draft.coins : null);
    await this.close();
  }

  static #onCancel() {
    this.close();
  }

  /** „Przywróć cenę z podręcznika”: wyłącza własną cenę i wpisuje cenę z podręcznika. */
  static #onUseBookPrice() {
    this.draft.useCustom = false;
    this.draft.coins = singleCurrency(bookPrice(this.item)?.value);
    this.render();
  }
}
