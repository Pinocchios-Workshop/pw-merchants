/**
 * Okno tworzenia i edycji kategorii sklepu (ApplicationV2, tylko MG).
 *
 * Zmiany trzymamy w szkicu (`draft`) do kliknięcia "Zapisz", żeby "Anuluj"
 * naprawdę niczego nie zmieniało. Kategoria może losować z kilku list towaru:
 * każda ma swój slot z wyborem zapisanej listy (lista rozwijana) i własnym zakresem
 * „od–do”. Pod ostatnim slotem z listą jest przycisk „+”, który dodaje kolejny slot;
 * każdy slot poza pierwszym ma kosz. Sloty ze starszymi tabelami losowymi Foundry
 * (sprzed list towaru) są pokazywane do odłączenia; nowych tabel nie podpinamy.
 */
import { TEMPLATES } from "../constants.js";
import { getCategories, upsertCategory, deleteCategory, getTableSummary, getListSummary, validateCountRange, rangeText } from "../shop-data.js";
import { getStockLists } from "../stock-lists-store.js";
import { DeleteCategoryDialog } from "./delete-category-dialog.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
/** Pusty slot: bez listy, zakres 1–1. */
function newSlot() {
  return { listId: null, uuid: null, countMin: 1, countMax: 1 };
}

/** Czy slot ma źródło towaru (listę albo starszą tabelę). */
const hasSource = (slot) => !!(slot?.listId || slot?.uuid);

export class CategoryConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Otwiera okno albo przywołuje już otwarte dla tej samej kategorii. */
  static open({ actor, categoryId = null }) {
    if (!game.user.isGM) return null;
    const id = `pf2e-shop-category-${actor.id}-${categoryId ?? "new"}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront();
    const app = new this({ id, actor, categoryId });
    app.render({ force: true });
    return app;
  }

  constructor({ actor, categoryId = null, ...options } = {}) {
    super(options);
    this.actor = actor;
    this.categoryId = categoryId;
    const saved = categoryId ? getCategories(actor).find((c) => c.id === categoryId) : null;
    /** Szkic edytowanej kategorii; zapisywany dopiero przy "Zapisz". */
    this.draft = {
      name: saved?.name ?? "",
      // Sloty tabel: zawsze co najmniej jeden (pierwszy, bez kosza).
      slots: saved?.tables?.length ? saved.tables.map((t) => ({ ...t })) : [newSlot()]
    };
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window"],
    window: { icon: "fa-solid fa-tags", resizable: false },
    position: { width: 520, height: "auto" },
    form: { handler: CategoryConfig.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: {
      cancel: CategoryConfig.#onCancel,
      openTable: CategoryConfig.#onOpenTable,
      unlinkTable: CategoryConfig.#onUnlinkTable,
      addTable: CategoryConfig.#onAddTable,
      removeTable: CategoryConfig.#onRemoveTable,
      deleteCategory: CategoryConfig.#onDeleteCategory
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.categoryConfig }
  };

  get isNew() {
    return !this.categoryId;
  }

  get title() {
    if (this.isNew) return game.i18n.localize("PF2E_SHOP.CategoryConfig.TitleNew");
    const name = getCategories(this.actor).find((c) => c.id === this.categoryId)?.name ?? "";
    return game.i18n.format("PF2E_SHOP.CategoryConfig.TitleEdit", { name });
  }

  async _prepareContext(options) {
    const collator = new Intl.Collator(game.i18n?.lang ?? "en", { sensitivity: "base" });
    const lists = getStockLists()
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((l) => ({ id: l.id, name: l.name, entries: l.entries.length }));
    const slots = [];
    const groups = [];
    for (const [index, slot] of this.draft.slots.entries()) {
      // Starsza tabela losowa (sprzed list towaru) albo lista towaru.
      const table = slot.uuid && !slot.listId ? await getTableSummary(slot.uuid) : null;
      const list = slot.listId ? getListSummary(slot.listId) : null;
      const error = this.#slotError(slot);
      slots.push({
        index,
        number: index + 1,
        table,
        tableMissing: !!slot.uuid && !slot.listId && !table,
        listMissing: !!slot.listId && !list,
        // Opcje listy rozwijanej: zapisane listy; bieżąca zaznaczona, a listy z innych slotów wyłączone.
        options: lists.map((l) => ({
          ...l,
          selected: l.id === slot.listId,
          taken: l.id !== slot.listId && this.draft.slots.some((s) => s.listId === l.id)
        })),
        countMin: slot.countMin,
        countMax: slot.countMax,
        error,
        removable: index > 0
      });
      const summary = list ?? table;
      if (summary) {
        const range = validateCountRange(slot.countMin, slot.countMax);
        groups.push({ ...summary, isList: !!list, range: range.error ? "?" : rangeText(range.min, range.max) });
      }
    }
    // „+” pod ostatnim slotem pojawia się dopiero, gdy ten slot ma listę.
    const last = this.draft.slots.at(-1);
    return {
      isNew: this.isNew,
      name: this.draft.name,
      slots,
      noLists: !lists.length,
      // Jak dawniej przy tabelach: „+” pod ostatnim slotem, gdy ten slot ma wybraną listę.
      canAdd: hasSource(last),
      groups,
      manyGroups: groups.length > 1,
      hasError: slots.some((s) => s.error)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    // Wpisane wartości trafiają do szkicu, żeby przetrwały ponowne renderowanie
    // (np. po podpięciu tabeli).
    this.element.querySelector("[name=name]")?.addEventListener("input", (ev) => {
      this.draft.name = ev.currentTarget.value;
    });
    // Zakresy „od–do” slotów: tylko liczby całkowite ≥ 0, „od” nie większe niż „do”.
    for (const input of this.element.querySelectorAll("[data-slot-count]")) {
      input.addEventListener("input", () => {
        const slot = this.draft.slots[Number(input.dataset.slot)];
        if (!slot) return;
        slot[input.dataset.slotCount] = input.value;
        this.#showErrors();
      });
    }
    this.#showErrors();

    // Lista slotów zachowuje przewinięcie między renderami (np. po upuszczeniu tabeli).
    const list = this.element.querySelector("[data-slot-list]");
    if (list) {
      list.scrollTop = this._slotScroll ?? 0;
      list.addEventListener("scroll", () => (this._slotScroll = list.scrollTop));
    }

    // Wybór listy towaru w slocie: zapis w szkicu i odświeżenie podglądu pozycji.
    for (const select of this.element.querySelectorAll("[data-slot-list-pick]")) {
      select.addEventListener("change", () => {
        const slot = this.draft.slots[Number(select.dataset.slot)];
        if (!slot) return;
        slot.listId = select.value || null;
        slot.uuid = null;
        this.render();
      });
    }
  }

  /** Klucz komunikatu błędu zakresu slotu albo null. */
  #slotError(slot) {
    return validateCountRange(slot.countMin, slot.countMax).error ?? null;
  }

  /** Podświetla błędne zakresy, pokazuje komunikaty przy slotach i blokuje „Zapisz”. */
  #showErrors() {
    const el = this.element;
    let any = false;
    for (const [index, slot] of this.draft.slots.entries()) {
      const error = this.#slotError(slot);
      any ||= !!error;
      for (const input of el.querySelectorAll(`[data-slot="${index}"][data-slot-count]`)) {
        input.classList.toggle("psm-input--bad", !!error);
      }
      const message = el.querySelector(`[data-slot-error="${index}"]`);
      if (message) {
        message.hidden = !error;
        message.textContent = error ? game.i18n.localize(error) : "";
      }
    }
    const save = el.querySelector("[type=submit]");
    if (save) save.disabled = any;
  }

  /** Numer slotu z elementu (przycisk albo lista rozwijana). */
  #slotIndex(element) {
    return Number(element?.closest("[data-slot]")?.dataset.slot ?? -1);
  }

  /* ---------------- Akcje ---------------- */

  static async #onSubmit(event, form, formData) {
    const values = formData.object;
    const name = String(values.name ?? "").trim();
    if (!name) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.CategoryConfig.NameRequired"));
      return;
    }
    const bad = this.draft.slots.map((slot) => this.#slotError(slot)).find(Boolean);
    if (bad) {
      ui.notifications.warn(game.i18n.localize(bad));
      return;
    }
    // Zapisujemy tylko sloty z listą (albo starszą tabelą); puste sloty znikają.
    await upsertCategory(this.actor, {
      id: this.categoryId,
      name,
      tables: this.draft.slots.filter(hasSource)
    });
    await this.close();
  }

  static #onCancel() {
    this.close();
  }

  static async #onOpenTable(event, target) {
    const slot = this.draft.slots[this.#slotIndex(target)];
    const table = slot?.uuid ? await fromUuid(slot.uuid).catch(() => null) : null;
    table?.sheet?.render(true);
  }

  /**
   * „Odłącz”: slot nad innymi slotami znika razem z tabelą (jak po koszu), a sloty
   * pod nim przesuwają się w górę, więc lista nie ma pustych przerw; odłączenie
   * pierwszego slotu robi z drugiego pierwszy. Ostatni (najniższy) albo jedyny
   * slot zostaje pusty, gotowy na upuszczenie innej tabeli.
   */
  static #onUnlinkTable(event, target) {
    const index = this.#slotIndex(target);
    const slot = this.draft.slots[index];
    if (!slot) return;
    if (index < this.draft.slots.length - 1) this.draft.slots.splice(index, 1);
    else Object.assign(slot, { uuid: null, listId: null });
    this.render();
  }

  /** „+”: nowy pusty slot pod ostatnim. */
  static async #onAddTable() {
    this.draft.slots.push(newSlot());
    // Nowy slot widoczny na dole przewijanej listy.
    this._slotScroll = Number.MAX_SAFE_INTEGER;
    await this.render();
  }

  /** Kosz: usuwa slot razem z tabelą (pierwszego slotu nie można usunąć). */
  static #onRemoveTable(event, target) {
    const index = this.#slotIndex(target);
    if (index <= 0) return;
    this.draft.slots.splice(index, 1);
    this.render();
  }

  static async #onDeleteCategory() {
    if (this.isNew) return;
    const confirmed = await DeleteCategoryDialog.confirm({ actor: this.actor, categoryId: this.categoryId });
    if (!confirmed) return;
    await deleteCategory(this.actor, this.categoryId);
    await this.close();
  }
}
