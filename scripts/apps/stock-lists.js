/**
 * Okno list towaru (MG): biblioteka list i edytor jednej listy w tym samym oknie
 * (zasada dwóch okien: karta sklepu → to okno).
 *
 * Działa: przechodzenie między biblioteką a edytorem, przeglądarka przedmiotów
 * w edytorze (kompendia systemu PF2e i przedmioty świata, wyszukiwanie i filtry jak
 * na karcie sklepu) i pozycje edytowanej listy: dodawanie („+” albo przeciągnięcie),
 * waga z przeliczaniem szans na bieżąco i usuwanie koszem. Edytor pracuje na szkicu
 * listy trzymanym w oknie; „Zapisz listę” zapisuje go w świecie (`stock-lists-store.js`)
 * i wraca do biblioteki, która pokazuje zapisane listy. W bibliotece: duplikowanie,
 * usuwanie, eksport listy do pliku JSON i import list z pliku (ten sam format co zapis).
 */
import { MODULE_ID, TEMPLATES } from "../constants.js";
import { getStockLists, getStockList, saveStockList, deleteStockList, duplicateStockList, levelRange, exportStockList, exportFileName, parseImport, importStockLists } from "../stock-lists-store.js";
import { DeleteStockListDialog } from "./delete-stock-list-dialog.js";
import { activateFilters, resetFilterState, matches, comparator, isChanged, normalize } from "../sheets/filters.js";
import { loadBrowserItems, loadBrowserSpells, PHYSICAL_TYPES } from "../item-index.js";
import { formBaseUuid, formName, formRank, formLevel, formMaxRank, canCastAtRank, spellFormOf } from "../spell-consumables.js";
import { rarityInfo } from "../shop-data.js";
import { toggleSummary } from "./item-summary.js";
import { windowSize, libraryRows, centerApp } from "../window-sizes.js";
import { partyLevel, levelChances } from "../stock-draw.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Ile wierszy przeglądarki pokazujemy naraz; na dole „Pokaż kolejne” / „Pokaż wszystkie”. */
const PAGE = 200;

/** Tryby losowania listy (na razie bez działania przy losowaniu). */
const DRAW_MODES = [
  { value: "manual", label: "PF2E_SHOP.StockLists.Modes.Manual", text: "PF2E_SHOP.StockLists.ModeTextManual", icon: "fa-scale-balanced" },
  { value: "partyLevel", label: "PF2E_SHOP.StockLists.Modes.PartyLevel", text: "PF2E_SHOP.StockLists.ModeTextLevel", icon: "fa-users" }
];

/** Szkic listy do edycji: kopia zapisanej listy albo nowa, pusta lista. */
function draftOf(id) {
  return getStockList(id) ?? { id: null, name: "", mode: "manual", guaranteed: false, drawLimit: false, entries: [], guaranteedEntries: [] };
}

/** Waga nowej pozycji listy. */
const NEW_WEIGHT = 1;


/**
 * Koszt rzucenia zaklęcia obok nazwy: symbole akcji PF2e (czcionka `.action-glyph`) dla
 * 1, 2, 3, reakcji i akcji swobodnej, zakres („1 to 3”) jako dwa symbole; inny czas
 * (np. „1 minute”) jako tekst.
 */
function actionCost(time) {
  const span = document.createElement("span");
  span.className = "psm-spell-cost";
  const value = String(time).trim().toLowerCase();
  const glyph = { reaction: "R", free: "F" }[value] ?? (/^[123]$/.test(value) ? value : null);
  const range = /^([123])\s*(?:to|-|–)\s*([123])$/.exec(value);
  const addGlyph = (text) => {
    const el = document.createElement("span");
    el.className = "action-glyph";
    el.textContent = text;
    span.append(el);
  };
  if (glyph) addGlyph(glyph);
  else if (range) {
    addGlyph(range[1]);
    span.append(" – ");
    addGlyph(range[2]);
  } else {
    span.classList.add("psm-micro");
    span.textContent = time;
  }
  return span;
}

export class StockListsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Jedno okno list dla całego świata (listy są wspólne dla wszystkich sklepów). */
  static open() {
    if (!game.user.isGM) return null;
    const id = `${MODULE_ID}-stock-lists`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront();
    const app = new this({ id });
    app.render({ force: true });
    return app;
  }

  constructor(options = {}) {
    // Rozmiar z presetu ekranu (1920 × 1080 / 2560 × 1440), patrz window-sizes.js.
    super(foundry.utils.mergeObject({ position: windowSize("stockLibrary") }, options, { inplace: false }));
    /** Stan okna: null = biblioteka, inaczej edytowana lista ({ id } zapisanej listy albo { id: null } = nowa). */
    this.editing = null;
    /**
     * Szkic edytowanej listy: { name, mode, guaranteed, drawLimit,
     *   entries: [{ uuid, name, img, level, rarity, weight, limit }],
     *   guaranteedEntries: [{ uuid, name, img, level, rarity, min, max }] }.
     */
    this.draft = null;
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    // „actor sheet”: te same style PF2e co karta sklepu (wygląd rozwiniętego opisu przedmiotu).
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-lists-window", "actor", "sheet"],
    window: { icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 820, height: "auto" },
    form: { handler: StockListsApp.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: {
      newList: StockListsApp.#onNewList,
      editList: StockListsApp.#onEditList,
      duplicateList: StockListsApp.#onDuplicateList,
      deleteList: StockListsApp.#onDeleteList,
      exportList: StockListsApp.#onExportList,
      importList: StockListsApp.#onImportList,
      backToLibrary: StockListsApp.#onBack,
      summary: StockListsApp.#onSummary,
      showMore: StockListsApp.#onShowMore,
      showAll: StockListsApp.#onShowAll,
      addItem: StockListsApp.#onAddItem,
      removeEntry: StockListsApp.#onRemoveEntry,
      toggleGuaranteed: StockListsApp.#onToggleGuaranteed,
      placeholder: StockListsApp.#onPlaceholder
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.stockLists }
  };

  get title() {
    if (!this.editing) return game.i18n.localize("PF2E_SHOP.StockLists.Title");
    const saved = this.editing.id ? getStockList(this.editing.id) : null;
    return saved
      ? game.i18n.format("PF2E_SHOP.StockLists.EditTitle", { name: saved.name })
      : game.i18n.localize("PF2E_SHOP.StockLists.NewTitle");
  }

  async _prepareContext() {
    if (this.editing) {
      const draft = (this.draft ??= draftOf(this.editing.id));
      // Poziom drużyny do podglądu szans w trybie według poziomu (losowanie liczy go od nowa).
      this._partyLevel = partyLevel();
      return {
        editor: {
          name: draft.name,
          guaranteed: !!draft.guaranteed,
          drawLimit: !!draft.drawLimit,
          partyLevel: this._partyLevel,
          modes: DRAW_MODES.map((mode) => ({ ...mode, selected: mode.value === draft.mode }))
        },
        // Panel „Lista zaklęć”: rangi zwoju 1–10.
        spellRanks: Array.from({ length: 10 }, (_, i) => i + 1)
      };
    }
    const collator = new Intl.Collator(game.i18n?.lang ?? "en", { sensitivity: "base" });
    const lists = getStockLists()
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((list, i) => ({
        id: list.id,
        name: list.name,
        entries: list.entries.length,
        levels: levelRange(list.entries),
        // Tryb losowania listy jako tag (ręczne wagi / według poziomu postaci).
        levelMode: list.mode === "partyLevel",
        modeLabel: DRAW_MODES.find((m) => m.value === list.mode)?.label ?? DRAW_MODES[0].label,
        odd: i % 2 === 1
      }));
    return { lists };
  }

  /** Przeglądarka przedmiotów: te same filtry i przełączniki grup co na karcie sklepu. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this.editing) return this.#activateLibrary();
    for (const kind of Object.keys(StockListsApp.KINDS)) this.#renderEntries(kind);
    this.#activateEditor();
    this.#activateSourceToggle();
    this.#activateSpellPanel();
    activateFilters(this.element, this, { apply: (html, state) => this.#applyBrowser(html, state) });
    // Przedmioty wczytywane przy pierwszym otwarciu edytora (kompendia raz na sesję).
    if (!this.items) {
      this.items = await loadBrowserItems();
      this.#resolveSampleEntries();
      this.render();
    } else if (this.browserSource === "spells" && !this.spells) {
      await this.#loadSpells();
    }
  }

  /* -------------------------------------------- */
  /*  Źródło przeglądarki: przedmioty albo zaklęcia */
  /* -------------------------------------------- */

  /**
   * „Lista przedmiotów” / „Lista zaklęć” (na lewo od zakresów): przeglądarka pokazuje
   * przedmioty fizyczne albo zaklęcia z kompendiów PF2e (pod zwoje i różdżki — dodawanie
   * zaklęć jeszcze niedostępne). Pozycje listy i przedmioty gwarantowane się nie zmieniają.
   * Filtry wspólne dla obu źródeł; w zaklęciach poziom = ranga, zakres ceny nieużywany.
   */
  #activateSourceToggle() {
    this.browserSource ??= "items";
    for (const button of this.element.querySelectorAll("[data-browser-source]")) {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const source = button.dataset.browserSource;
        if (source === this.browserSource) return;
        this.browserSource = source;
        if (source === "spells" && !this.spells) await this.#loadSpells();
        else if (this._browserState) this.#applyBrowser(this.element, this._browserState);
      });
    }
    this.#markSource();
  }

  /** Wczytuje indeks zaklęć (raz na sesję), z napisem „Wczytywanie zaklęć…” w liście. */
  async #loadSpells() {
    this.#markSource();
    const list = this.element.querySelector("[data-browser-list]");
    if (list) {
      const loading = document.createElement("li");
      loading.className = "psm-item psm-item--empty";
      loading.textContent = game.i18n.localize("PF2E_SHOP.StockLists.LoadingSpells");
      list.replaceChildren(loading);
    }
    this.spells = await loadBrowserSpells();
    if (this._browserState && this.element) this.#applyBrowser(this.element, this._browserState);
  }

  /**
   * Panel pod filtrami w trybie „Lista zaklęć”: forma (zwój; różdżka później) i jej ustawienia.
   * Zwój: ranga (zawsze konkretna, 1–10; domyślnie 10 — wszystkie zaklęcia) — lista pokazuje tylko zaklęcia o randze
   * bazowej nie wyższej (np. bez Fireball przy randze 1), a „+” / pinezka dodają zwój tej rangi.
   */
  #activateSpellPanel() {
    this.spellOptions ??= { form: "scroll", rank: "10" };
    const panel = this.element.querySelector("[data-spell-panel]");
    if (!panel) return;
    for (const button of panel.querySelectorAll("[data-spell-form]")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (button.dataset.spellForm === this.spellOptions.form) return;
        this.spellOptions.form = button.dataset.spellForm;
        // Różdżki mają rangi do 9: wyższa wybrana ranga schodzi do najwyższej dostępnej.
        const max = formMaxRank(this.spellOptions.form);
        if (Number(this.spellOptions.rank) > max) this.spellOptions.rank = String(max);
        this.#markSpellPanel();
        if (this._browserState) this.#applyBrowser(this.element, this._browserState);
      });
    }
    for (const select of panel.querySelectorAll("[data-spell-option]")) {
      select.value = this.spellOptions[select.dataset.spellOption] ?? "";
      select.addEventListener("change", () => {
        this.spellOptions[select.dataset.spellOption] = select.value;
        this.#markSpellPanel();
        if (this._browserState) this.#applyBrowser(this.element, this._browserState);
      });
    }
    this.#markSpellPanel();
  }

  /** Widoczność panelu zaklęć i ustawień wybranej formy; cena zwoju wybranej rangi po prawej. */
  #markSpellPanel() {
    const panel = this.element.querySelector("[data-spell-panel]");
    if (!panel) return;
    const form = this.spellOptions?.form ?? "scroll";
    const price = panel.querySelector("[data-scroll-price]");
    if (price) {
      const rank = Number(this.spellOptions?.rank) || 10;
      const base = this.items?.find((i) => i.uuid === formBaseUuid(form, rank));
      price.textContent = base?.price ?? "—";
    }
    // Te same ustawienia dla zwoju i różdżki — zmienia się tylko podpis i rangi (różdżki do 9).
    const wand = form === "wand";
    const rankLabel = panel.querySelector("[data-spell-rank-label]");
    if (rankLabel) rankLabel.textContent = game.i18n.localize(wand ? "PF2E_SHOP.StockLists.WandRank" : "PF2E_SHOP.StockLists.ScrollRank");
    const priceLabel = panel.querySelector("[data-spell-price-label]");
    if (priceLabel) priceLabel.textContent = game.i18n.localize(wand ? "PF2E_SHOP.StockLists.WandPrice" : "PF2E_SHOP.StockLists.ScrollPrice");
    const select = panel.querySelector('[data-spell-option="rank"]');
    if (select) {
      const max = formMaxRank(form);
      for (const option of select.options) option.disabled = option.hidden = Number(option.value) > max;
      select.value = this.spellOptions?.rank ?? "10";
    }
    panel.hidden = this.browserSource !== "spells";
    for (const button of panel.querySelectorAll("[data-spell-form]")) {
      button.setAttribute("aria-pressed", String(button.dataset.spellForm === this.spellOptions?.form));
    }
  }

  /**
   * Czy zaklęcie pasuje do ustawień formy (zwój i różdżka tak samo). Ranga N: zaklęcie o randze
   * bazowej N albo niższej, które da się podwyższyć do N (co `interval` rang albo na wymienione rangi).
   */
  #spellFits(spell) {
    return canCastAtRank(spell.level, spell.heighten, Number(this.spellOptions?.rank) || 10);
  }

  /**
   * Pozycja-zwój albo pozycja-różdżka (wybrana forma) dla zaklęcia z przeglądarki:
   * { uuid zaklęcia, nazwa „Scroll of X (Rank N)” / „Wand of X (Rank N)”, obrazek i poziom
   * bazowego przedmiotu tej rangi, rzadkość zaklęcia, scroll | wand: { rank } }.
   */
  #spellChoice(spell) {
    const form = this.spellOptions?.form ?? "scroll";
    const rank = formRank(spell.level, this.spellOptions?.rank, formMaxRank(form));
    const base = this.items?.find((i) => i.uuid === formBaseUuid(form, rank));
    return {
      uuid: spell.uuid,
      name: formName(form, spell.name, rank),
      img: base?.img ?? spell.img,
      level: base?.level ?? formLevel(form, rank),
      rarity: spell.rarity ?? "common",
      [form]: { rank }
    };
  }

  /** Przyciski źródła, nagłówek kolumny poziomu (ranga) i pola ceny według wybranego źródła. */
  #markSource() {
    const spells = this.browserSource === "spells";
    this.#markSpellPanel();
    for (const button of this.element.querySelectorAll("[data-browser-source]")) {
      button.setAttribute("aria-pressed", String(button.dataset.browserSource === (this.browserSource ?? "items")));
    }
    const levelCol = this.element.querySelector("[data-browser-level-col]");
    if (levelCol) levelCol.textContent = game.i18n.localize(spells ? "PF2E_SHOP.StockLists.BaseRank" : "PF2E_SHOP.Inventory.Level");
    // Sortowanie: przy zaklęciach „Ranga → nazwa” (to samo pole — ranga bazowa zaklęcia).
    const sortLevel = this.element.querySelector('[data-filter="sort"] option[value="level"]');
    if (sortLevel) sortLevel.textContent = game.i18n.localize(spells ? "PF2E_SHOP.Filters.SortRank" : "PF2E_SHOP.Filters.SortLevel");
    const title = this.element.querySelector("[data-browser-title]");
    if (title) title.textContent = game.i18n.localize(spells ? "PF2E_SHOP.StockLists.SpellResults" : "PF2E_SHOP.StockLists.Results");
    // Lista zaklęć: zakresy poziomu i ceny wyłączone (zaklęcia zawęża ranga zwoju), sortowanie bez ceny.
    for (const input of this.element.querySelectorAll('[data-filter="levelMin"], [data-filter="levelMax"], [data-filter="priceMin"], [data-filter="priceMax"]')) input.disabled = spells;
    for (const range of this.element.querySelectorAll(".psm-lists__browser .psm-range")) range.classList.toggle("psm-range--off", spells);
    const sortSelect = this.element.querySelector('[data-filter="sort"]');
    for (const option of sortSelect?.querySelectorAll('option[value^="price"]') ?? []) {
      option.hidden = spells;
      option.disabled = spells;
    }
    if (spells && sortSelect && sortSelect.value.startsWith("price")) {
      sortSelect.value = "level";
      if (this._browserState) this._browserState.sort = "level";
    }
    // Lista zaklęć: kolumny „Ranga” i przyciski dodawania, bez ceny.
    this.element.querySelector(".psm-lists__browser")?.classList.toggle("psm-lists__browser--spells", spells);
  }

  /** Wpisy przeglądarki dla wybranego źródła (null = jeszcze się wczytują). */
  #browserEntries() {
    return this.browserSource === "spells" ? this.spells ?? null : this.items ?? null;
  }

  /* -------------------------------------------- */
  /*  Pozycje listy                                */
  /* -------------------------------------------- */

  /**
   * Dwie listy pozycji w edytorze, obsługiwane tym samym kodem:
   * - `entries`: pozycje losowane (waga i szansa),
   * - `guaranteed`: przedmioty gwarantowane (zawsze na stanie, ilość od–do);
   *   widoczne tylko po zaznaczeniu „Przedmioty gwarantowane” w ustawieniach listy.
   */
  static KINDS = {
    entries: { field: "entries", list: "[data-entries-list]", count: "[data-entries-count]", drop: "[data-entries-drop]", button: "addItem", icon: "fa-plus", label: "PF2E_SHOP.StockLists.Add", hint: "PF2E_SHOP.StockLists.DropHint" },
    guaranteed: { field: "guaranteedEntries", list: "[data-guaranteed-list]", count: "[data-guaranteed-count]", drop: "[data-guaranteed-drop]", button: "toggleGuaranteed", icon: "fa-thumbtack", label: "PF2E_SHOP.StockLists.AddGuaranteed", hint: "PF2E_SHOP.StockLists.GuaranteedDropHint" }
  };

  /** Klucz pozycji: UUID przedmiotu (pozycja bez UUID: nazwa). */
  static #key(entry) {
    // Zwój z zaklęcia: to samo zaklęcie na różnych rangach to różne pozycje.
    const spellForm = spellFormOf(entry);
    if (spellForm) return `${entry.uuid}#${spellForm.form}-${spellForm.rank}`;
    return entry.uuid ?? `name:${entry.name.toLocaleLowerCase()}`;
  }

  /** Pozycje danej listy szkicu (tablica tworzona, gdy jej brak). */
  #entries(kind) {
    const field = StockListsApp.KINDS[kind].field;
    return (this.draft[field] ??= []);
  }

  /** Pozycja danej listy z tym przedmiotem (wpis przeglądarki) albo undefined. */
  #entryFor(item, kind = "entries") {
    if (!this.draft) return undefined;
    // Zwój: to samo zaklęcie i ta sama ranga; przedmiot: UUID (bez UUID — nazwa), z pominięciem zwojów.
    const spellForm = spellFormOf(item);
    if (spellForm) return this.#entries(kind).find((e) => e.uuid === item.uuid && e[spellForm.form]?.rank === spellForm.rank);
    return this.#entries(kind).find((e) => !spellFormOf(e) && (e.uuid ? e.uuid === item.uuid : e.name.toLocaleLowerCase() === item.name.toLocaleLowerCase()));
  }

  /** Biblioteka: wyszukiwarka zapisanych list po nazwie (ukrywa niepasujące wiersze). */
  #activateLibrary() {
    // Najwyżej tyle widocznych list, ile przewiduje preset ekranu (Full HD 6, 2560 × 1440: 10); dalej przewijanie.
    this.element.querySelector(".psm-lists__library")?.style.setProperty("--psm-lib-rows", String(libraryRows()));
    const search = this.element.querySelector("[data-list-search]");
    search?.addEventListener("input", () => {
      const query = normalize(search.value);
      let visible = 0;
      for (const row of this.element.querySelectorAll("[data-list-id]")) {
        row.hidden = !!query && !normalize(row.dataset.listName).includes(query);
        row.classList.toggle("odd", !row.hidden && visible % 2 === 1);
        if (!row.hidden) visible += 1;
      }
      const none = this.element.querySelector("[data-list-no-match]");
      if (none) none.hidden = visible > 0;
    });
  }

  /** Pozycje bez UUID (np. z importu) dostają UUID przedmiotu o tej samej nazwie z przeglądarki. */
  #resolveSampleEntries() {
    for (const kind of Object.keys(StockListsApp.KINDS)) {
      for (const entry of this.#entries(kind)) {
        if (entry.uuid) continue;
        const item = this.items.find((i) => i.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase());
        if (item) {
          Object.assign(entry, { uuid: item.uuid, img: item.img, level: item.level, rarity: item.rarity ?? entry.rarity });
          delete entry.missing;
        }
      }
    }
  }

  /**
   * Szanse pozycji losowanych na pojedyncze losowanie (klucz pozycji → 0–1): ręczne wagi
   * = waga / suma wag; tryb według poziomu = funkcja wykładnicza dla obecnego poziomu
   * drużyny (`levelChances`, ten sam model co losowanie).
   */
  #chances() {
    const entries = this.draft.entries;
    const values = this.draft.mode === "partyLevel"
      ? levelChances(entries, this._partyLevel ?? NaN)
      : (() => {
          const total = entries.reduce((sum, e) => sum + e.weight, 0);
          return entries.map((e) => (total > 0 ? e.weight / total : 0));
        })();
    return new Map(entries.map((e, i) => [StockListsApp.#key(e), values[i]]));
  }

  /** Szansa jako tekst w procentach, z jednym miejscem po przecinku. */
  static #percent(value) {
    const chance = Math.round((value ?? 0) * 1000) / 10;
    return `${chance.toLocaleString(game.i18n?.lang ?? "en")}%`;
  }

  /** Buduje od nowa listę pozycji danego rodzaju, posortowaną: poziom → nazwa. */
  #renderEntries(kind = "entries") {
    const config = StockListsApp.KINDS[kind];
    const list = this.element.querySelector(config.list);
    if (!list) return;
    const entries = this.#entries(kind);
    // To samo porównanie co sortowanie „Poziom → nazwa” na karcie sklepu.
    entries.sort(comparator("level"));
    list.replaceChildren(...entries.map((entry, i) => this.#entryRow(entry, i, kind)));
    const drop = document.createElement("li");
    drop.className = "psm-item psm-lists__drop";
    drop.textContent = game.i18n.localize(config.hint);
    list.append(drop);
    const count = this.element.querySelector(config.count);
    if (count) count.textContent = String(entries.length);
  }

  /** Przelicza szanse wszystkich pozycji (po zmianie wagi, trybu, listy), bez przebudowy wierszy. */
  #updateChances() {
    const chances = this.#chances();
    for (const [key, value] of chances) {
      const cell = this.element.querySelector(`[data-entry-chance="${CSS.escape(key)}"]`);
      if (cell) cell.textContent = StockListsApp.#percent(value);
    }
  }

  /** Pole liczbowe w wierszu pozycji (waga, limit, ilość od, ilość do). Puste = brak wartości. */
  static #numberInput(value, min, field, key, label, placeholder) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.step = "1";
    input.value = value === null || value === undefined ? "" : String(value);
    if (placeholder) input.placeholder = placeholder;
    input.dataset.entryField = field;
    input.dataset.entryKey = key;
    input.setAttribute("aria-label", label);
    return input;
  }

  /**
   * Jeden wiersz pozycji: obrazek, nazwa (rozwija opis), potem kolumny zależne od listy
   * (losowane: waga i szansa; gwarantowane: ilość od i do), na końcu kosz.
   */
  #entryRow(entry, index, kind) {
    const key = StockListsApp.#key(entry);
    const rarity = rarityInfo(entry.rarity);
    const li = document.createElement("li");
    li.className = `psm-item${index % 2 ? " odd" : ""}`;
    if (entry.uuid) li.dataset.itemUuid = entry.uuid;
    if (rarity.rarityColor) li.style.borderLeftColor = rarity.rarityColor;

    const img = document.createElement("img");
    img.className = "psm-item__img";
    img.src = entry.img;
    img.alt = "";

    const name = document.createElement("span");
    name.className = "psm-item__name";
    if (entry.uuid) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "psm-item__toggle";
      toggle.dataset.action = "summary";
      toggle.textContent = entry.name;
      toggle.setAttribute("aria-label", `${game.i18n.localize("PF2E_SHOP.Inventory.ShowDetails")}: ${entry.name}`);
      name.append(toggle);
    } else {
      const text = document.createElement("span");
      text.textContent = entry.name;
      name.append(text);
    }
    // Pozycja z importu, której przedmiotu nie ma w tym świecie (zostaje, nie znika po cichu).
    if (entry.missing) {
      const tag = document.createElement("span");
      tag.className = "psm-tag psm-micro psm-lists__missing";
      tag.textContent = game.i18n.localize("PF2E_SHOP.StockLists.NotFound");
      tag.dataset.psmTooltip = game.i18n.localize("PF2E_SHOP.StockLists.NotFoundHint");
      name.append(tag);
    }

    const columns = [];
    if (kind === "guaranteed") {
      for (const [field, labelKey] of [["min", "PF2E_SHOP.StockLists.Min"], ["max", "PF2E_SHOP.StockLists.Max"]]) {
        const cell = document.createElement("span");
        cell.className = "psm-col psm-col--qty";
        cell.append(StockListsApp.#numberInput(entry[field], 1, field, key, `${game.i18n.localize(labelKey)}: ${entry.name}`));
        columns.push(cell);
      }
    } else {
      const weightCell = document.createElement("span");
      weightCell.className = "psm-col psm-col--weight";
      weightCell.append(StockListsApp.#numberInput(entry.weight, 0, "weight", key, `${game.i18n.localize("PF2E_SHOP.CategoryConfig.EntryWeight")}: ${entry.name}`));
      // Limit wylosowań (widoczny, gdy lista ma włączone „Limit wylosowań”); puste = bez limitu.
      const limitCell = document.createElement("span");
      limitCell.className = "psm-col psm-col--limit";
      limitCell.append(StockListsApp.#numberInput(entry.limit, 1, "limit", key, `${game.i18n.localize("PF2E_SHOP.StockLists.Limit")}: ${entry.name}`, "∞"));
      const chance = document.createElement("span");
      chance.className = "psm-col psm-col--chance";
      chance.dataset.entryChance = key;
      chance.textContent = StockListsApp.#percent(this.#chances().get(key));
      // Poziom przedmiotu (widoczny w trybie według poziomu, zamiast wagi).
      const level = document.createElement("span");
      level.className = "psm-col psm-col--level";
      level.textContent = String(entry.level ?? 0);
      columns.push(level, weightCell, limitCell, chance);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "psm-col psm-col--action psm-icon-btn psm-icon-btn--danger";
    remove.dataset.action = "removeEntry";
    remove.dataset.entry = key;
    remove.dataset.kind = kind;
    remove.setAttribute("aria-label", `${game.i18n.localize("PF2E_SHOP.Inventory.Remove")}: ${entry.name}`);
    remove.innerHTML = `<i class="fa-solid fa-trash" inert></i>`;

    li.append(img, name, ...columns, remove);
    if (entry.uuid) {
      const summary = document.createElement("div");
      summary.className = "item-summary psm-item__summary";
      summary.hidden = true;
      li.append(summary);
    }
    return li;
  }

  /** Dodaje przedmiot do listy danego rodzaju (pomija przedmiot, który już na niej jest). */
  #addEntry({ uuid, name, img, level, rarity, scroll = null, wand = null }, kind = "entries") {
    if (this.#entryFor({ uuid, name, scroll, wand }, kind)) {
      ui.notifications.info(game.i18n.format("PF2E_SHOP.StockLists.AlreadyIn", { name }));
      return false;
    }
    const base = { uuid, name, img, level: Number(level) || 0, rarity: rarity ?? "common", scroll: scroll ? { rank: scroll.rank } : null, wand: wand ? { rank: wand.rank } : null };
    this.#entries(kind).push(kind === "guaranteed" ? { ...base, min: 1, max: 1 } : { ...base, weight: NEW_WEIGHT, limit: null });
    this.#renderEntries(kind);
    if (uuid) this.#markBrowserRow(uuid);
    return true;
  }

  /** Usuwa wszystkie przedmioty gwarantowane (po wyłączeniu opcji); pinezki w przeglądarce wracają do stanu „dodaj”. */
  #clearGuaranteed() {
    const removed = this.#entries("guaranteed").splice(0);
    this.#renderEntries("guaranteed");
    for (const entry of removed) if (entry.uuid) this.#markBrowserRow(entry.uuid);
  }

  /** Usuwa pozycję z listy danego rodzaju (kosz albo przycisk w przeglądarce). */
  #removeEntry(key, kind = "entries") {
    const entries = this.#entries(kind);
    const index = entries.findIndex((e) => StockListsApp.#key(e) === key);
    if (index < 0) return;
    const [entry] = entries.splice(index, 1);
    this.#renderEntries(kind);
    if (kind === "entries") this.#updateChances();
    if (entry.uuid) this.#markBrowserRow(entry.uuid);
  }

  /** Ustawia przycisk „+” / ✓ albo pinezkę w wierszu przeglądarki według stanu obu list. */
  #setBrowserButton(button, item, kind) {
    const config = StockListsApp.KINDS[kind];
    const inList = !!this.#entryFor(item, kind);
    button.classList.toggle("psm-sell-add--in", inList);
    button.setAttribute("aria-pressed", String(inList));
    const icon = kind === "entries" && inList ? "fa-check" : config.icon;
    button.innerHTML = `<i class="fa-solid ${icon}" inert></i>`;
    const label = inList ? (kind === "entries" ? "PF2E_SHOP.StockLists.RemoveFromList" : "PF2E_SHOP.StockLists.RemoveGuaranteed") : config.label;
    button.setAttribute("aria-label", `${game.i18n.localize(label)}: ${item.name}`);
    button.dataset.psmTooltip = game.i18n.localize(label);
  }

  /** Odświeża przyciski w widocznym wierszu przeglądarki, bez przebudowy listy. */
  #markBrowserRow(uuid) {
    const row = this.element.querySelector(`[data-browser-list] > [data-item-uuid="${CSS.escape(uuid)}"]`);
    if (!row) return;
    const spell = this.browserSource === "spells" ? this.spells?.find((s) => s.uuid === uuid) : null;
    const item = spell ? this.#spellChoice(spell) : { uuid, name: row.querySelector(".psm-item__toggle")?.textContent ?? "" };
    row.classList.toggle("psm-lists__result--in", !!this.#entryFor(item));
    for (const [kind, config] of Object.entries(StockListsApp.KINDS)) {
      const button = row.querySelector(`[data-action="${config.button}"]`);
      if (button) this.#setBrowserButton(button, item, kind);
    }
  }

  /** Przełącza przedmiot z wiersza przeglądarki na liście danego rodzaju (dodaje albo usuwa). */
  #toggleFromBrowser(target, kind) {
    const uuid = target.closest("[data-item-uuid]")?.dataset.itemUuid;
    const found = this.#browserEntries()?.find((i) => i.uuid === uuid);
    if (!found) return;
    // Zaklęcie trafia na listę jako zwój wybranej rangi.
    const item = found.spell ? this.#spellChoice(found) : found;
    const entry = this.#entryFor(item, kind);
    if (entry) this.#removeEntry(StockListsApp.#key(entry), kind);
    else this.#addEntry(item, kind);
  }

  /** „+” w wierszu przeglądarki dodaje przedmiot do pozycji losowanych; ✓ go usuwa. */
  static #onAddItem(event, target) {
    this.#toggleFromBrowser(target, "entries");
  }

  /** Pinezka w wierszu przeglądarki dodaje przedmiot do gwarantowanych albo go z nich usuwa. */
  static #onToggleGuaranteed(event, target) {
    this.#toggleFromBrowser(target, "guaranteed");
  }

  /** Kosz w wierszu pozycji: usuwa przedmiot z listy. */
  static #onRemoveEntry(event, target) {
    this.#removeEntry(target.dataset.entry, target.dataset.kind ?? "entries");
  }

  /** Przedmiot upuszczony na listę: z przeglądarki, kompendium albo katalogu przedmiotów. */
  async #onDrop(event, kind) {
    event.preventDefault();
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    const data = TextEditor.getDragEventData(event);
    if (data?.type !== "Item" || !data.uuid) return;
    const known = this.items?.find((i) => i.uuid === data.uuid);
    if (known) return void this.#addEntry(known, kind);
    const item = await fromUuid(data.uuid).catch(() => null);
    if (!item) return;
    if (!PHYSICAL_TYPES.has(item.type)) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.StockLists.NotPhysical"));
      return;
    }
    this.#addEntry({ uuid: item.uuid, name: item.name, img: item.img, level: item.system?.level?.value, rarity: item.system?.traits?.rarity }, kind);
  }

  /**
   * Opcje zależne od ustawień listy (stopniowe odkrywanie):
   * - tryb według poziomu: bez pól wag, z poziomem przedmiotu i poziomem drużyny,
   * - lista przedmiotów gwarantowanych i pinezki w przeglądarce tylko po zaznaczeniu
   *   „Przedmioty gwarantowane”,
   * - kolumna „Limit” w pozycjach listy tylko po zaznaczeniu „Limit wylosowań”.
   */
  #showModeOptions() {
    const root0 = this.element.querySelector(".psm-lists");
    // Tryb według poziomu: zamiast wag kolumna poziomu, szanse z funkcji wykładniczej, poziom drużyny w ustawieniach.
    root0?.classList.toggle("psm-lists--level", this.draft.mode === "partyLevel");
    this.#updateChances();
    const guaranteed = !!this.draft.guaranteed;
    const section = this.element.querySelector("[data-guaranteed]");
    if (section) section.hidden = !guaranteed;
    const root = this.element.querySelector(".psm-lists");
    root?.classList.toggle("psm-lists--guaranteed", guaranteed);
    // Kolumna „Limit” w pozycjach listy tylko po zaznaczeniu „Limit wylosowań”.
    root?.classList.toggle("psm-lists--limit", !!this.draft.drawLimit);
  }

  /** Upuszczanie przedmiotów na listę danego rodzaju. */
  #activateDrop(kind) {
    const drop = this.element.querySelector(StockListsApp.KINDS[kind].drop);
    if (!drop) return;
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("psm-drop-target");
    });
    drop.addEventListener("dragleave", (event) => {
      if (!drop.contains(event.relatedTarget)) drop.classList.remove("psm-drop-target");
    });
    drop.addEventListener("drop", (event) => {
      drop.classList.remove("psm-drop-target");
      this.#onDrop(event, kind);
    });
  }

  /** Pola edytora: nazwa i ustawienia listy, wartości pozycji, upuszczanie przedmiotów. */
  #activateEditor() {
    const html = this.element;
    for (const input of html.querySelectorAll("[data-draft]")) {
      input.addEventListener(input.type === "text" ? "input" : "change", () => {
        if (input.type === "radio" && !input.checked) return;
        this.draft[input.dataset.draft] = input.type === "checkbox" ? input.checked : input.value;
        // Odznaczenie „Przedmioty gwarantowane” usuwa wszystkie przedmioty gwarantowane z listy.
        if (input.dataset.draft === "guaranteed" && !input.checked) this.#clearGuaranteed();
        if (["mode", "guaranteed", "drawLimit"].includes(input.dataset.draft)) this.#showModeOptions();
      });
    }
    this.#showModeOptions();

    // Wartości w wierszach: waga (szanse na bieżąco), ilość od–do (od ≤ do).
    for (const kind of Object.keys(StockListsApp.KINDS)) {
      const list = html.querySelector(StockListsApp.KINDS[kind].list);
      const entryOf = (input) => this.#entries(kind).find((e) => StockListsApp.#key(e) === input.dataset.entryKey);
      list?.addEventListener("input", (event) => {
        const input = event.target.closest("[data-entry-field]");
        const entry = input && entryOf(input);
        if (!entry) return;
        const field = input.dataset.entryField;
        // Limit może być pusty (bez limitu); pozostałe pola zawsze mają liczbę.
        if (field === "limit") entry.limit = input.value === "" ? null : Math.max(1, Math.floor(Number(input.value) || 1));
        else entry[field] = Math.max(field === "weight" ? 0 : 1, Math.floor(Number(input.value) || 0));
        if (field === "weight") this.#updateChances();
      });
      list?.addEventListener("change", (event) => {
        const input = event.target.closest("[data-entry-field]");
        const entry = input && entryOf(input);
        if (!entry) return;
        // Zakres ilości zawsze poprawny: „od” nie większe niż „do”.
        if (input.dataset.entryField === "min" && entry.min > entry.max) entry.max = entry.min;
        if (input.dataset.entryField === "max" && entry.max < entry.min) entry.min = entry.max;
        for (const field of ["weight", "limit", "min", "max"]) {
          const other = input.closest("li")?.querySelector(`[data-entry-field="${field}"]`);
          if (other && entry[field] !== undefined) other.value = entry[field] === null ? "" : String(entry[field]);
        }
      });
      list?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target.closest("[data-entry-field]")) {
          event.preventDefault();
          event.target.blur();
        }
      });
      this.#activateDrop(kind);
    }

    // Przeciąganie z przeglądarki: wiersz niesie UUID przedmiotu (jak przedmiot z kompendium).
    html.querySelector("[data-browser-list]")?.addEventListener("dragstart", (event) => {
      const row = event.target.closest?.("[data-item-uuid]");
      if (!row) return;
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: row.dataset.itemUuid }));
    });
  }

  /**
   * Filtruje przedmioty tą samą logiką co kartę sklepu i wstawia pierwszą stronę
   * pasujących wierszy. Zmiana filtrów zaczyna od pierwszej strony.
   */
  #applyBrowser(html, state) {
    const reset = html.querySelector("[data-filter-reset]");
    if (reset) reset.disabled = !isChanged(state);
    this._browserState = state;
    this.#markSource();
    const entries = this.#browserEntries();
    if (!entries) return; // „Wczytywanie…” zostaje do czasu wczytania indeksu
    const sort = comparator(state.sort);
    // Zaklęcia: zakresy poziomu i ceny ich nie dotyczą (zawęża je ranga zwoju).
    const query = this.browserSource === "spells" ? { ...state, levelMin: null, levelMax: null, priceMin: null, priceMax: null } : state;
    const spells = this.browserSource === "spells";
    this._found = entries
      .filter((item) => matches(item.filter, query) && (!spells || this.#spellFits(item)))
      .sort((a, b) => sort(a.filter, b.filter));
    this._shown = 0;
    html.querySelector("[data-browser-list]")?.replaceChildren();
    this.#showRows(html, PAGE);
  }

  /** Dokłada kolejne wiersze na dole listy (otwarte opisy zostają rozwinięte). */
  #showRows(html, count) {
    const list = html.querySelector("[data-browser-list]");
    if (!list) return;
    const found = this._found ?? [];
    list.querySelector(":scope > [data-browser-more]")?.remove();
    const next = found.slice(this._shown, this._shown + count);
    list.append(...next.map((item, i) => this.#browserRow(item, this._shown + i)));
    this._shown += next.length;

    if (!found.length) {
      const empty = document.createElement("li");
      empty.className = "psm-item psm-item--empty";
      empty.textContent = game.i18n.localize("PF2E_SHOP.StockLists.NoMatch");
      list.append(empty);
    }
    const rest = found.length - this._shown;
    if (rest > 0) list.append(this.#moreRow(rest, found.length));

    const countEl = html.querySelector("[data-browser-count]");
    if (countEl) countEl.textContent = String(found.length);
    const meta = html.querySelector("[data-browser-meta]");
    if (meta) {
      meta.textContent = rest > 0 ? game.i18n.format("PF2E_SHOP.StockLists.Showing", { shown: this._shown, total: found.length }) : "";
    }
  }

  /** Wiersz na dole listy: „Pokaż kolejne 200” i „Pokaż wszystkie (N)”. */
  #moreRow(rest, total) {
    const li = document.createElement("li");
    li.className = "psm-item psm-lists__more";
    li.dataset.browserMore = "";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "psm-btn psm-btn--neutral";
    more.dataset.action = "showMore";
    more.innerHTML = `<i class="fa-solid fa-angles-down" inert></i> `;
    more.append(game.i18n.format("PF2E_SHOP.StockLists.ShowMore", { count: Math.min(PAGE, rest) }));
    const all = document.createElement("button");
    all.type = "button";
    all.className = "psm-btn psm-btn--neutral";
    all.dataset.action = "showAll";
    all.innerHTML = `<i class="fa-solid fa-list" inert></i> `;
    all.append(game.i18n.format("PF2E_SHOP.StockLists.ShowAll", { count: total }));
    li.append(more, all);
    return li;
  }

  static #onShowMore() {
    this.#showRows(this.element, PAGE);
  }

  static #onShowAll() {
    this.#showRows(this.element, Infinity);
  }

  /** Kliknięcie nazwy: opis przedmiotu jak na karcie sklepu (jeden rozwinięty naraz). */
  static async #onSummary(event, target) {
    await toggleSummary(target.closest("[data-item-uuid]"));
  }

  /** Jeden wiersz przeglądarki (jak wiersz towaru na karcie sklepu). */
  #browserRow(item, index) {
    // Zaklęcie: stan przycisków według zwoju wybranej rangi.
    const target = item.spell ? this.#spellChoice(item) : item;
    const inList = !!this.#entryFor(target);
    const li = document.createElement("li");
    li.className = `psm-item${index % 2 ? " odd" : ""}${inList ? " psm-lists__result--in" : ""}`;
    // Opis rozwijany przez wspólny moduł opisów (apps/item-summary.js), po UUID.
    li.dataset.itemUuid = item.uuid;
    // Zaklęcia dodaje się przyciskami (jako zwoje wybranej rangi), bez przeciągania.
    li.draggable = !item.spell;
    if (item.rarityColor) li.style.borderLeftColor = item.rarityColor;
    const img = document.createElement("img");
    img.className = "psm-item__img";
    img.src = item.img;
    img.alt = "";
    const name = document.createElement("span");
    name.className = "psm-item__name";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "psm-item__toggle";
    toggle.dataset.action = "summary";
    toggle.textContent = item.name;
    toggle.setAttribute("aria-label", `${game.i18n.localize("PF2E_SHOP.Inventory.ShowDetails")}: ${item.name}`);
    name.append(toggle);
    // Zaklęcie: koszt rzucenia w akcjach (symbole akcji PF2e) obok nazwy.
    if (item.spell && item.time) name.append(actionCost(item.time));
    if (item.showRarity) {
      const tag = document.createElement("span");
      tag.className = "psm-rarity psm-micro";
      tag.style.background = item.rarityColor;
      tag.textContent = item.rarityLabel;
      name.append(tag);
    }
    const level = document.createElement("span");
    level.className = "psm-col psm-col--level";
    level.textContent = String(item.level);
    const price = document.createElement("span");
    price.className = "psm-col psm-col--price";
    price.textContent = item.price;
    // Przyciski: „+” (pozycje losowane) i pinezka (gwarantowane; widoczna, gdy lista ma gwarantowane).
    const add = document.createElement("span");
    add.className = "psm-col psm-lists__col-add";
    for (const [kind, config] of Object.entries(StockListsApp.KINDS)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `psm-sell-add${kind === "guaranteed" ? " psm-lists__pin" : ""}`;
      button.dataset.action = config.button;
      this.#setBrowserButton(button, target, kind);
      add.append(button);
    }
    const summary = document.createElement("div");
    summary.className = "item-summary psm-item__summary";
    summary.hidden = true;
    li.append(img, name, level, price, add, summary);
    return li;
  }

  /** Przełącza stan okna i dopasowuje jego szerokość. Nowa lista = filtry od zera. */
  async #show(editing) {
    if (editing !== this.editing) resetFilterState(this);
    this.editing = editing;
    this.draft = null; // nowy szkic przy każdym wejściu do edytora (zapis list później)
    await this.render();
    if (editing) this.#fitEditor();
    else {
      // Biblioteka: rozmiar z presetu, potem na środek ekranu według rzeczywistej wysokości.
      this.setPosition(windowSize("stockLibrary"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      centerApp(this);
    }
  }

  /** Rozmiar edytora z presetu ekranu (window-sizes.js), na środku ekranu. */
  #fitEditor() {
    this.setPosition(windowSize("stockEditor", { center: true }));
  }



  static #onNewList() {
    return this.#show({ id: null });
  }

  static #onEditList(event, target) {
    const id = target.closest("[data-list-id]")?.dataset.listId;
    if (id) return this.#show({ id });
  }

  static #onBack() {
    return this.#show(null);
  }

  /** Nazwa kopii (duplikat, import listy o zajętej nazwie): „Nazwa (kopia)”, „Nazwa (kopia 2)”… */
  static #copyName(name, n) {
    return game.i18n.format(n > 1 ? "PF2E_SHOP.StockLists.CopyNameN" : "PF2E_SHOP.StockLists.CopyName", { name, n });
  }

  /** „Duplikuj”: zapisuje kopię listy i odświeża bibliotekę. */
  static async #onDuplicateList(event, target) {
    const id = target.closest("[data-list-id]")?.dataset.listId;
    if (!id) return;
    const copy = await duplicateStockList(id, StockListsApp.#copyName);
    if (copy) ui.notifications.info(game.i18n.format("PF2E_SHOP.StockLists.Duplicated", { name: copy.name }));
    this.render();
  }

  /** „Usuń”: okno potwierdzenia (wspólne `ConfirmDialog`), potem usunięcie listy ze świata. */
  static async #onDeleteList(event, target) {
    const id = target.closest("[data-list-id]")?.dataset.listId;
    const list = id ? getStockList(id) : null;
    if (!list) return;
    if (!(await DeleteStockListDialog.confirm({ list }))) return;
    await deleteStockList(id);
    ui.notifications.info(game.i18n.format("PF2E_SHOP.StockLists.Deleted", { name: list.name }));
    this.render();
  }

  /** „Eksportuj”: plik JSON z dokumentem listy (ten sam co w zapisie świata). */
  static #onExportList(event, target) {
    const id = target.closest("[data-list-id]")?.dataset.listId;
    const list = id ? getStockList(id) : null;
    const text = id ? exportStockList(id) : null;
    if (!list || !text) return;
    const save = foundry.utils.saveDataToFile ?? globalThis.saveDataToFile;
    save(text, "application/json", exportFileName(list.name));
  }

  /** „Importuj listę”: wybór pliku JSON, odczyt, dopasowanie przedmiotów, zapis w świecie. */
  static #onImportList() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (file) await this.#importFile(file);
    });
    input.click();
  }

  /**
   * Import pliku: listy przez wspólny odczyt (`parseImport` → `readStockList`), potem
   * dopasowanie przedmiotów do tego świata — najpierw po UUID, a gdy go nie ma, po nazwie
   * w przedmiotach z kompendiów PF2e i świata. Pozycja nieznaleziona zostaje z oznaczeniem.
   */
  async #importFile(file) {
    const { lists, errors } = parseImport(await file.text());
    for (const error of new Set(errors)) ui.notifications.error(game.i18n.localize(error));
    if (!lists.length) return;
    const items = (this.items ??= await loadBrowserItems());
    const byUuid = new Map(items.map((i) => [i.uuid, i]));
    const byName = new Map();
    for (const item of items) if (!byName.has(item.name.toLocaleLowerCase())) byName.set(item.name.toLocaleLowerCase(), item);
    let missing = 0;
    for (const list of lists) {
      for (const entry of [...list.entries, ...list.guaranteedEntries]) {
        const found = (entry.uuid && byUuid.get(entry.uuid)) || byName.get(entry.name.toLocaleLowerCase());
        if (found) {
          Object.assign(entry, { uuid: found.uuid, img: found.img, level: found.level, rarity: found.rarity ?? entry.rarity });
          delete entry.missing;
        } else if (!(entry.uuid && (await fromUuid(entry.uuid).catch(() => null)))) {
          entry.missing = true;
          missing += 1;
        }
      }
    }
    const saved = await importStockLists(lists, StockListsApp.#copyName);
    ui.notifications.info(game.i18n.format("PF2E_SHOP.StockLists.Imported", { names: saved.map((l) => l.name).join(", ") }));
    if (missing) ui.notifications.warn(game.i18n.format("PF2E_SHOP.StockLists.ImportMissing", { count: missing }));
    this.render();
  }

  static #onPlaceholder() {
    ui.notifications.info(game.i18n.localize("PF2E_SHOP.NotImplemented"));
  }

  /** „Zapisz listę”: zapisuje szkic w świecie i wraca do biblioteki. Lista musi mieć nazwę. */
  static async #onSubmit() {
    if (!this.draft) return;
    if (!this.draft.name.trim()) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.StockLists.NameRequired"));
      this.element.querySelector("[data-draft='name']")?.focus();
      return;
    }
    const saved = await saveStockList(this.draft);
    ui.notifications.info(game.i18n.format("PF2E_SHOP.StockLists.SavedNote", { name: saved.name }));
    return this.#show(null);
  }
}
