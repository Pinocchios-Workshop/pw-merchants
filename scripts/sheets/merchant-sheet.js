/**
 * Widok merchanta.
 *
 * Moduł nie rejestruje osobnej karty, tylko podpina się pod kartę loota
 * systemu PF2e (`LootSheetPF2e`, ApplicationV1). Dzięki temu działa niezależnie
 * od tego, którą kartę Foundry ma zapisaną jako domyślną.
 *
 * Podpinamy pięć miejsc, zawsze wywołując oryginał:
 *   - `template`          w trybie Merchant zwraca nasz szablon,
 *   - `getData`           w trybie Merchant dokłada dane sklepu (`shop`),
 *   - `activateListeners` w trybie Merchant dokłada nasze przyciski,
 *   - `_render`           ustawia rozmiar okna i klasy CSS,
 *   - `_onDropItem`       w trybie Merchant przypisuje przedmiot do kategorii,
 *                         nad którą go upuszczono.
 * W trybie Loot wszystko działa dokładnie jak w PF2e.
 */
import { windowSize, centerApp } from "../window-sizes.js";
import { MODULE_ID, TEMPLATES, OTHER_CATEGORY, BUYBACK_CATEGORY } from "../constants.js";
import { newItemFlags } from "../shop-store.js";
import {
  getShopData, getPurse, getWares, prepareWareRow,
  getCategories, getItemCategory, setItemCategory, getSourceName,
  moveCategory, shiftCategory, getCategoryItems, clearCategoryItems, findStackTarget,
  setPriceModifier, itemModifier, getShopTags, removeShopTag
} from "../shop-data.js";
import { CategoryConfig } from "../apps/category-config.js";
import { openRandomizeDialog } from "../apps/randomize-dialog.js";
import { ClearCategoryDialog } from "../apps/clear-category-dialog.js";
import { ItemConfig } from "../apps/item-config.js";
import { PurseConfig } from "../apps/purse-config.js";
import { DescriptionConfig } from "../apps/description-config.js";
import { PurchaseDialog } from "../apps/purchase-dialog.js";
import { SellDialog } from "../apps/sell-dialog.js";
import { StockListsApp } from "../apps/stock-lists.js";
import { rememberSummaryRenderer, toggleSummary, restoreSummary } from "../apps/item-summary.js";
import { activateFilters, resetFilterState, refreshFilters } from "./filters.js";
import { activateShopTags } from "./shop-tags.js";
import { activateCategoryChips } from "./category-chips.js";

/** Rozmiar okna przy pierwszym otwarciu w trybie Merchant. */
/** Rozmiar karty sklepu z presetu ekranu (1920 × 1080 / 2560 × 1440), patrz window-sizes.js. */
const merchantSize = () => windowSize("merchantSheet");

/** Znacznik, że klasa została już podpięta (ochrona przed podwójnym patchem). */
const PATCHED = Symbol.for(`${MODULE_ID}.patched`);

/**
 * Kategoria, nad którą MG upuścił nowy przedmiot. Ustawiana na czas wywołania
 * oryginalnego `_onDropItem`; hook `preCreateItem` wpisuje ją do tworzonego przedmiotu.
 * @type {{actorId: string, categoryId: string|null}|null}
 */
let pendingDrop = null;

/** Czy karta pokazuje aktora w trybie Merchant. */
export function isMerchantSheet(sheet) {
  const actor = sheet?.actor;
  return actor?.type === "loot" && actor.system?.lootSheetType === "Merchant";
}

/** Szuka deskryptora właściwości w łańcuchu prototypów. */
function findDescriptor(proto, key) {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const descriptor = Object.getOwnPropertyDescriptor(p, key);
    if (descriptor) return descriptor;
  }
  return null;
}

/**
 * Hook dla przedmiotu upuszczonego na kartę sklepu przez MG:
 *   - jeśli w tej samej kategorii jest już ten sam przedmiot (ten sam oryginał,
 *     ten sam typ amunicji, zgoda PF2e), zwiększa jego ilość i anuluje tworzenie nowego;
 *   - w przeciwnym razie nowy przedmiot dostaje id kategorii we flagach.
 * Hook PF2e `_preCreate` działa wcześniej, więc typ amunicji specjalnej jest już wybrany.
 */
function registerCreateHook() {
  Hooks.on("preCreateItem", (item, data, options, userId) => {
    if (!pendingDrop || userId !== game.user.id) return;
    const actor = item.parent;
    if (actor?.id !== pendingDrop.actorId) return;

    const target = findStackTarget(actor, item, pendingDrop.categoryId);
    if (target) {
      const added = Math.max(1, Number(item._source?.system?.quantity ?? item.system?.quantity ?? item.quantity) || 1);
      target.update({ "system.quantity": (target.quantity ?? 0) + added });
      ui.notifications.info(game.i18n.format("PF2E_SHOP.Inventory.Stacked", { name: target.name, count: added }));
      return false;
    }
    item.updateSource({ [`flags.${MODULE_ID}`]: newItemFlags(item._source?.flags?.[MODULE_ID], pendingDrop.categoryId) });
  });

  // Zabezpieczenie: po zapisaniu nowego przedmiotu w sklepie (gdy typ amunicji jest już
  // ostatecznie ustalony) łączymy go z tym samym przedmiotem w jego kategorii.
  // Obejmuje każdą drogę dodania: kartę, token, aktora w katalogu, kompendium, świat.
  Hooks.on("createItem", (item, options, userId) => {
    if (userId !== game.user.id) return;
    const actor = item.parent;
    if (actor?.type !== "loot" || actor.system?.lootSheetType !== "Merchant") return;
    consolidateStack(actor, item);
  });
}

/** Czy przedmiot `a` powstał wcześniej niż `b` (czas utworzenia, potem id). */
function isOlder(a, b) {
  const ta = a._stats?.createdTime ?? 0;
  const tb = b._stats?.createdTime ?? 0;
  return ta !== tb ? ta < tb : String(a.id) < String(b.id);
}

/** Kategoria przedmiotu tak, jak pokazuje ją karta: nieznana albo brak = "Inne" (null), „Odkup” osobno. */
function displayedCategory(actor, item) {
  const id = getItemCategory(item);
  if (id === BUYBACK_CATEGORY) return id;
  return id && getCategories(actor).some((c) => c.id === id) ? id : null;
}

/**
 * Dosumowuje świeżo utworzony przedmiot do tego samego przedmiotu w jego kategorii
 * (ten sam oryginał, ten sam typ amunicji, zgoda PF2e) i usuwa nową pozycję.
 * Bez komunikatu: z perspektywy MG i graczy pozycja po prostu ma większą ilość.
 */
async function consolidateStack(actor, item) {
  if (!item?.isOfType?.("physical") || item.isCoinage) return;
  const target = findStackTarget(actor, item, displayedCategory(actor, item));
  // Nowszy dołącza do starszego; jeśli trafiliśmy na nowszy, jego własny hook to zrobi.
  if (!target || !isOlder(target, item)) return;
  await target.update({ "system.quantity": (target.quantity ?? 0) + (item.quantity ?? 0) });
  await item.delete();
}

/**
 * Podpina widok merchanta pod klasę karty loota z PF2e.
 * @param {typeof ActorSheet} LootSheet
 * @returns {boolean} czy się udało
 */
export function patchLootSheet(LootSheet) {
  const proto = LootSheet?.prototype;
  if (!proto) return false;
  if (proto[PATCHED]) return true;

  const templateDescriptor = findDescriptor(proto, "template");
  const originalGetData = proto.getData;
  const originalActivate = proto.activateListeners;
  const originalRender = proto._render;
  const originalDropItem = proto._onDropItem;
  const originalClose = proto.close;
  if (!templateDescriptor?.get || !originalGetData || !originalActivate || !originalRender || !originalDropItem) {
    console.error(`${MODULE_ID} | Karta loota PF2e ma inną budowę niż oczekiwana, widok merchanta wyłączony`);
    return false;
  }

  Object.defineProperty(proto, "template", {
    configurable: true,
    get() {
      return isMerchantSheet(this) ? TEMPLATES.merchantSheet : templateDescriptor.get.call(this);
    }
  });

  proto.getData = async function (...args) {
    const data = await originalGetData.apply(this, args);
    if (isMerchantSheet(this)) data.shop = prepareShop(this, data);
    return data;
  };

  proto.activateListeners = function ($html) {
    originalActivate.call(this, $html);
    if (isMerchantSheet(this)) activateShopListeners(this, $html[0] ?? $html);
  };

  proto._render = async function (force, options) {
    const merchant = isMerchantSheet(this);
    const wasMerchant = this._psmMerchant;
    this._psmMerchant = merchant;
    if (merchant && !this.rendered) Object.assign(this.position, merchantSize());
    // Odświeżenie karty (np. po zmianie mnożnika cen, ilości, kategorii) nie
    // przewija jej na górę: zapamiętujemy przewinięcie i przywracamy je po renderze.
    const scrollTop = this.element?.[0]?.querySelector("form.psm-sheet")?.scrollTop ?? 0;
    await originalRender.call(this, force, options);
    // Klasa "loot" włącza style karty loota z PF2e, które rozbiłyby nasz układ.
    const el = this.element?.[0];
    if (!el) return;
    // Zmiana trybu na otwartej karcie: nowy sklep startuje jako Loot (węższa karta),
    // więc po przełączeniu na Merchant karta dostaje rozmiar sklepu, a po powrocie
    // na Loot domyślny rozmiar karty loota.
    if (this.rendered && wasMerchant !== undefined && wasMerchant !== merchant) {
      this.setPosition(merchant ? merchantSize() : { width: this.options.width, height: this.options.height });
      centerApp(this);
    }
    const scroller = el.querySelector("form.psm-sheet");
    if (merchant && scroller && scrollTop) scroller.scrollTop = scrollTop;
    el.classList.toggle("pf2e-shop", merchant);
    el.classList.toggle("psm-window", merchant);
    el.classList.toggle("loot", !merchant);
    // Gracz bez prawa edycji: Foundry blokuje wszystkie pola karty, a filtry
    // i rozwijanie opisów mają działać. Odblokowujemy je po renderowaniu.
    const form = el.querySelector("form.psm-sheet");
    if (merchant && form) {
      enablePlayerControls(form);
      refreshFilters(form, this);
    }
  };

  proto._onDropItem = async function (event, data, ...rest) {
    if (!isMerchantSheet(this)) return originalDropItem.call(this, event, data, ...rest);
    // Gracz nie może dawać ani sprzedawać przedmiotów sklepowi: nic się nie
    // dzieje (przedmiot zostaje u gracza, pieniądze bez zmian), tylko komunikat.
    if (!game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Inventory.NoPlayerDrop"));
      return [];
    }
    const target = event?.target?.closest?.("[data-category-id]");
    // Upuszczenie poza sekcjami kategorii = "Inne".
    const categoryId = !target || target.dataset.categoryId === OTHER_CATEGORY ? null : target.dataset.categoryId;

    // Przedmiot z tego samego sklepu: zmiana kategorii zamiast sortowania.
    const item = await Item.implementation.fromDropData(data).catch(() => null);
    if (item?.parent?.uuid === this.actor.uuid) {
      if (!target) return originalDropItem.call(this, event, data, ...rest);
      // Ten sam przedmiot już jest w kategorii docelowej: łączymy pozycje.
      const stackTarget = getItemCategory(item) === categoryId ? null : findStackTarget(this.actor, item, categoryId);
      if (stackTarget) {
        const added = item.quantity ?? 0;
        await stackTarget.update({ "system.quantity": (stackTarget.quantity ?? 0) + added });
        await item.delete();
        ui.notifications.info(game.i18n.format("PF2E_SHOP.Inventory.Stacked", { name: stackTarget.name, count: added }));
        return [stackTarget];
      }
      await setItemCategory(item, categoryId);
      return [item];
    }

    // Nowy przedmiot (np. z kompendium): PF2e go tworzy, a hook łączy go z tym samym
    // przedmiotem w kategorii albo dopisuje mu kategorię.
    pendingDrop = { actorId: this.actor.id, categoryId };
    try {
      return await originalDropItem.call(this, event, data, ...rest);
    } finally {
      pendingDrop = null;
    }
  };

  // Filtry nie są zapisywane: po zamknięciu okna wracają do domyślnych.
  if (originalClose) {
    proto.close = async function (...args) {
      resetFilterState(this);
      this._psmTagsObserver?.disconnect();
      delete this._psmTagsObserver;
      this._psmChipsObserver?.disconnect();
      delete this._psmChipsObserver;
      this._psmChipsWatcher?.disconnect();
      delete this._psmChipsWatcher;
      delete this._psmChipsOpen;
      delete this._psmOpenSummary;
      delete this._psmTagsOpen;
      return originalClose.apply(this, args);
    };
  }

  registerCreateHook();
  proto[PATCHED] = true;
  return true;
}

/* ---------------- Dane do szablonu ---------------- */

function sortRows(rows) {
  rows.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
  rows.forEach((row, index) => (row.odd = index % 2 === 1));
  return rows;
}

function categoryMeta(category) {
  if (!category.tables.length) return game.i18n.localize("PF2E_SHOP.Category.NoList");
  const missing = game.i18n.localize("PF2E_SHOP.Category.TableMissing");
  const names = category.tables.map((t) => getSourceName(t) ?? missing);
  if (names.length === 1) return game.i18n.format("PF2E_SHOP.Category.ListMeta", { table: names[0] });
  return game.i18n.format("PF2E_SHOP.Category.ListMetaMany", { tables: names.join(", ") });
}

function prepareShop(sheet, data) {
  const actor = sheet.actor;
  const { priceModifier } = getShopData(actor);
  const custom = getCategories(actor);

  // Rozdział towaru na kategorie; nieznane albo brak kategorii = "Inne".
  const groups = new Map(custom.map((c) => [c.id, []]));
  const other = [];
  const buyback = [];
  for (const item of getWares(actor)) {
    // „Odkup” ma własną cenę (75%, bez mnożnika sklepu).
    const modifier = itemModifier(actor, item);
    const row = prepareWareRow(item, modifier);
    row.showBase = game.user.isGM && modifier !== 1;
    const categoryId = getItemCategory(item);
    if (categoryId === BUYBACK_CATEGORY) buyback.push(row);
    else (groups.get(categoryId) ?? other).push(row);
  }

  const categories = custom.map((c) => {
    const items = sortRows(groups.get(c.id));
    return { id: c.id, name: c.name, meta: categoryMeta(c), items, count: items.length, editable: true };
  });
  // "Inne" pokazujemy, gdy ma towar albo gdy nie ma jeszcze żadnej kategorii.
  if (other.length || !custom.length) {
    categories.push({
      id: OTHER_CATEGORY,
      name: game.i18n.localize("PF2E_SHOP.Category.Other"),
      meta: game.i18n.localize("PF2E_SHOP.Category.OtherMeta"),
      items: sortRows(other),
      count: other.length,
      editable: false
    });
  }
  // „Odkup”: przedmioty sprzedane sklepowi przez graczy; pokazywany, gdy coś w nim jest.
  if (buyback.length) {
    categories.push({
      id: BUYBACK_CATEGORY,
      name: game.i18n.localize("PF2E_SHOP.Category.Buyback"),
      meta: game.i18n.localize("PF2E_SHOP.Category.BuybackMeta"),
      items: sortRows(buyback),
      count: buyback.length,
      editable: false,
      buyback: true
    });
  }

  const description = data.enrichedContent?.description ?? "";
  return {
    isGM: game.user.isGM,
    name: actor.name,
    img: actor.img,
    purse: getPurse(actor),
    tags: getShopTags(actor).map((name, index) => ({ name, index })),
    showTagDot: game.user.isGM || getShopTags(actor).length > 0,
    modifierPercent: Math.round(priceModifier * 100),
    showBasePrice: game.user.isGM && priceModifier !== 1,
    categories,
    // Podpowiedź „kliknij nazwę, żeby rozwinąć opis” tylko, gdy jest jakikolwiek towar.
    hasWares: categories.some((c) => c.count > 0 || c.items?.length > 0),
    description,
    hasDescription: !!String(description).replace(/<[^>]*>/g, "").trim()
  };
}

/* ---------------- Nasłuch i akcje ---------------- */

/**
 * Kontrolki, z których gracz korzysta na karcie, której nie może edytować:
 * filtry, przełączniki kategorii, rozwijanie opisu, lista tagów. Foundry
 * blokuje je razem z resztą formularza, więc odblokowujemy tylko te.
 */
const PLAYER_CONTROLS = [
  "[data-filter]",
  "[data-filter-reset]",
  "[data-category-chip]",
  ".psm-item__toggle",
  "[data-shop-tags-more]",
  "[data-chips-more]",
  "[data-shop-action=buy]:not([data-sold-out])",
  "[data-shop-action=sell]"
].join(", ");

function enablePlayerControls(html) {
  if (game.user.isGM) return;
  for (const el of html.querySelectorAll(PLAYER_CONTROLS)) {
    el.disabled = false;
    if (el.tagName === "TEXTAREA") el.readOnly = false;
  }
}

/**
 * Gracz nie może przenosić przedmiotów ze sklepu (np. na kartę postaci).
 * PF2e pozwala przeciągać przedmioty także z kart tylko do podglądu, więc
 * zatrzymujemy start przeciągania jeszcze przed jego obsługą w PF2e.
 */
function blockPlayerDrag(html) {
  if (game.user.isGM) return;
  for (const el of html.querySelectorAll("[data-item-id], [data-item-id] img, [draggable=true]")) {
    el.setAttribute("draggable", "false");
  }
  html.addEventListener(
    "dragstart",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true }
  );
}

function activateShopListeners(sheet, html) {
  rememberSummaryRenderer(sheet);
  enablePlayerControls(html);
  blockPlayerDrag(html);
  html.addEventListener("click", (event) => {
    const button = event.target.closest("[data-shop-action]");
    if (!button) return;
    event.preventDefault();
    onShopAction(sheet, button.dataset.shopAction, button);
  });

  // Rozwijany opis przedmiotu: wspólny moduł opisów (apps/item-summary.js), jak w pozostałych oknach.
  // Po odświeżeniu karty wraca opis, który był otwarty.
  restoreSummary(html, sheet._psmOpenSummary, { actor: sheet.actor, shop: sheet.actor });

  // Wyszukiwanie, zakresy poziomu i ceny, sortowanie (MG i gracz).
  activateFilters(html, sheet);

  // Tagi sklepu w jednej linii z „+N” (MG i gracz).
  activateShopTags(sheet, html);
  activateCategoryChips(sheet, html);

  if (!game.user.isGM) return;
  activateModifierSlider(sheet, html);
  activateHeaderEditing(sheet, html);
  activateQuantityInputs(sheet, html);
  activateItemDropHighlight(html);
  activateCategoryReorder(sheet, html);
}

/**
 * Nagłówek (MG): nazwa sklepu edytowana w miejscu (zapis po Enter albo wyjściu
 * z pola). Tagi sklepu obsługuje `shop-tags.js`.
 */
function activateHeaderEditing(sheet, html) {
  const name = html.querySelector("[data-shop-name]");
  name?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      name.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      name.value = sheet.actor.name;
      name.blur();
    }
  });
  name?.addEventListener("change", async (event) => {
    event.stopPropagation();
    const value = name.value.trim();
    if (!value) {
      name.value = sheet.actor.name;
      return;
    }
    if (value !== sheet.actor.name) await sheet.actor.update({ name: value });
  });
}

/**
 * Suwak mnożnika cen (MG): w trakcie przesuwania zmienia tylko etykietę,
 * a po puszczeniu suwaka zapisuje mnożnik w sklepie. Zapis odświeża kartę
 * u wszystkich, więc gracze od razu widzą nowe ceny.
 */
function activateModifierSlider(sheet, html) {
  const slider = html.querySelector("[data-shop-modifier]");
  const label = html.querySelector("[data-shop-modifier-label]");
  if (!slider) return;
  slider.addEventListener("input", (event) => {
    event.stopPropagation();
    if (label) label.textContent = `${slider.value}%`;
  });
  slider.addEventListener("change", async (event) => {
    event.stopPropagation();
    await setPriceModifier(sheet.actor, Number(slider.value) / 100);
  });
  // Kółko myszy nad suwakiem przewija kartę, a nie zmienia mnożnika. Foundry
  // zmienia wartość suwaków kółkiem przez własny nasłuch; przechwytujemy zdarzenie
  // na karcie (faza capture), zanim do niego dotrze. Domyślne przewijanie zostaje.
  html.addEventListener(
    "wheel",
    (event) => {
      if (event.target === slider) event.stopPropagation();
    },
    { capture: true }
  );
}

/**
 * Pole ilości w wierszu (MG): zapis do ilości przedmiotu w ekwipunku sklepikarza.
 * Zapisuje po zatwierdzeniu (Enter albo wyjście z pola). Ilość 0 zostawia
 * przedmiot na liście jako wyprzedany; całą pozycję usuwa kosz w wierszu.
 */
function activateQuantityInputs(sheet, html) {
  for (const input of html.querySelectorAll("[data-item-quantity]")) {
    const itemId = input.closest("[data-item-id]")?.dataset.itemId;
    const item = sheet.actor.items.get(itemId);
    if (!item) continue;

    // Enter zatwierdza pole, zamiast wysyłać cały formularz karty.
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      input.blur();
    });

    input.addEventListener("change", async (event) => {
      event.stopPropagation();
      const value = Math.floor(Number(input.value));
      const current = item.quantity ?? 0;
      if (input.value.trim() === "" || !Number.isFinite(value) || value < 0) {
        input.value = current;
        return;
      }
      if (value === current) return;
      await item.update({ "system.quantity": value });
    });
  }
}


/** Podświetlenie kategorii, nad którą MG trzyma przeciągany przedmiot. */
function activateItemDropHighlight(html) {
  for (const section of html.querySelectorAll(".psm-category[data-category-id]")) {
    let depth = 0;
    const clear = () => {
      depth = 0;
      section.classList.remove("psm-drop-target");
    };
    section.addEventListener("dragenter", () => {
      if (draggedCategory) return;
      depth += 1;
      section.classList.add("psm-drop-target");
    });
    section.addEventListener("dragleave", () => {
      if (draggedCategory) return;
      depth -= 1;
      if (depth <= 0) clear();
    });
    section.addEventListener("drop", clear);
  }
}

/* ---------------- Zmiana kolejności kategorii ---------------- */

/**
 * Kategoria przeciągana właśnie za uchwyt w nagłówku.
 * W czasie przeciągania przeglądarka nie pozwala odczytać danych, więc trzymamy je tutaj.
 * @type {{actorId: string, categoryId: string}|null}
 */
let draggedCategory = null;

/** Czy kursor jest w górnej połowie sekcji (wstaw przed) czy w dolnej (wstaw za). */
function dropPlace(section, event) {
  const rect = section.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function clearReorderMarks(html) {
  for (const el of html.querySelectorAll(".psm-reorder-before, .psm-reorder-after, .psm-reordering")) {
    el.classList.remove("psm-reorder-before", "psm-reorder-after", "psm-reordering");
  }
}

/**
 * MG przeciąga kategorię za uchwyt w nagłówku i upuszcza ją nad albo pod inną.
 * Upuszczenie na "Inne" przenosi kategorię na koniec listy.
 * Z klawiatury: uchwyt w fokusie + strzałka w górę / w dół.
 */
function activateCategoryReorder(sheet, html) {
  const actor = sheet.actor;

  for (const handle of html.querySelectorAll("[data-category-handle]")) {
    const categoryId = handle.dataset.categoryHandle;
    const section = handle.closest(".psm-category");

    handle.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      draggedCategory = { actorId: actor.id, categoryId };
      event.dataTransfer.effectAllowed = "move";
      // Własny typ danych: karta PF2e i Foundry go zignorują.
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: "pf2e-shop.Category", actorUuid: actor.uuid, categoryId }));
      if (section) event.dataTransfer.setDragImage(section, 24, 16);
      requestAnimationFrame(() => section?.classList.add("psm-reordering"));
    });

    handle.addEventListener("dragend", () => {
      draggedCategory = null;
      clearReorderMarks(html);
    });

    handle.addEventListener("keydown", async (event) => {
      const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (!delta) return;
      event.preventDefault();
      if (await shiftCategory(actor, categoryId, delta)) {
        // Po ponownym renderowaniu przywracamy fokus na uchwyt tej samej kategorii.
        Hooks.once(`render${sheet.constructor.name}`, (app, $el) => {
          const el = $el?.[0] ?? $el;
          el?.querySelector?.(`[data-category-handle="${categoryId}"]`)?.focus();
        });
      }
    });
  }

  for (const section of html.querySelectorAll(".psm-category[data-category-id]")) {
    const isOther = [OTHER_CATEGORY, BUYBACK_CATEGORY].includes(section.dataset.categoryId);

    section.addEventListener("dragover", (event) => {
      if (!draggedCategory || draggedCategory.actorId !== actor.id) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const place = isOther ? "before" : dropPlace(section, event);
      section.classList.toggle("psm-reorder-before", place === "before");
      section.classList.toggle("psm-reorder-after", place === "after");
    });

    section.addEventListener("dragleave", (event) => {
      if (!draggedCategory || section.contains(event.relatedTarget)) return;
      section.classList.remove("psm-reorder-before", "psm-reorder-after");
    });

    section.addEventListener("drop", async (event) => {
      if (!draggedCategory || draggedCategory.actorId !== actor.id) return;
      // Zatrzymujemy zdarzenie, żeby karta PF2e nie potraktowała go jak upuszczenia przedmiotu.
      event.preventDefault();
      event.stopPropagation();
      const { categoryId } = draggedCategory;
      const targetId = isOther ? null : section.dataset.categoryId;
      const place = isOther ? "after" : dropPlace(section, event);
      draggedCategory = null;
      clearReorderMarks(html);
      await moveCategory(actor, categoryId, targetId, place);
    });
  }
}

function onShopAction(sheet, action, button) {
  switch (action) {
    case "summary":
      return toggleSummary(button.closest("[data-item-id]"), { actor: sheet.actor, shop: sheet.actor }).then(
        (key) => (sheet._psmOpenSummary = key)
      );
    case "new-category":
      return CategoryConfig.open({ actor: sheet.actor });
    case "category-settings":
      return CategoryConfig.open({ actor: sheet.actor, categoryId: button.dataset.categoryId });
    case "randomize":
      return openRandomizeDialog(sheet.actor);
    case "clear-category":
      return confirmClearCategory(sheet.actor, button.dataset.categoryId);
    case "remove-item":
      return removeItem(sheet.actor, button.closest("[data-item-id]")?.dataset.itemId);
    case "item-settings":
      return ItemConfig.open({ actor: sheet.actor, itemId: button.closest("[data-item-id]")?.dataset.itemId });
    case "sell":
      return SellDialog.open({ shop: sheet.actor });
    case "buy":
      return PurchaseDialog.open({ shop: sheet.actor, itemId: button.closest("[data-item-id]")?.dataset.itemId });
    case "edit-description":
      return DescriptionConfig.open({ actor: sheet.actor });
    case "edit-purse":
      return PurseConfig.open({ actor: sheet.actor });
    case "remove-tag":
      return removeShopTag(sheet.actor, Number(button.dataset.tagIndex));
    case "stock-lists":
      return StockListsApp.open();
    case "reset-modifier":
      return setPriceModifier(sheet.actor, 1);
    case "view-art":
      return showArt(sheet.actor);
    default:
      return ui.notifications.info(game.i18n.localize("PF2E_SHOP.NotImplemented"));
  }
}

/** Art sklepikarza w powiększeniu (widok gracza; gracz nie może go zmienić). */
function showArt(actor) {
  const Popout = foundry.applications.apps?.ImagePopout ?? globalThis.ImagePopout;
  if (!Popout || !actor?.img) return;
  new Popout({ src: actor.img, uuid: actor.uuid, window: { title: actor.name } }).render({ force: true });
}

/**
 * Kosz w wierszu: usuwa całą pozycję ze sklepu, niezależnie od ilości, bez potwierdzenia.
 */
async function removeItem(actor, itemId) {
  if (!game.user.isGM || !itemId) return;
  await actor.deleteEmbeddedDocuments("Item", [itemId]);
}

/**
 * Kosz w nagłówku kategorii: usuwa wszystkie przedmioty z kategorii (także z "Inne"),
 * po potwierdzeniu we własnym oknie. Sama kategoria zostaje; usunąć ją można tylko
 * w jej ustawieniach.
 */
async function confirmClearCategory(actor, categoryId) {
  if (!game.user.isGM || !categoryId) return;
  if (!getCategoryItems(actor, categoryId).length) {
    ui.notifications.info(game.i18n.localize("PF2E_SHOP.ClearCategory.AlreadyEmpty"));
    return;
  }
  const confirmed = await ClearCategoryDialog.confirm({ actor, categoryId });
  if (!confirmed) return;
  const removed = await clearCategoryItems(actor, categoryId);
  ui.notifications.info(game.i18n.format("PF2E_SHOP.ClearCategory.Done", { count: removed }));
}
