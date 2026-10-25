/**
 * Rozwijany opis przedmiotu — JEDYNE miejsce, które go buduje i pokazuje.
 *
 * Używają go wszystkie okna modułu: karta sklepu (MG i gracz), sprzedaż, propozycja
 * MG i przeglądarka list towaru. Dzięki temu opis wygląda i działa wszędzie tak samo:
 * - treść: szablon opisu PF2e (cechy, poziom, cena, opis) przez renderer PF2e;
 * - dodatki modułu: cena sklepu (po mnożniku i z własną ceną), typ amunicji,
 *   użycie runy; akapit „Ammunition …” z opisu jest wtedy usuwany;
 * - zachowanie: jeden rozwinięty opis naraz w liście, animacja jak w PF2e,
 *   a okno pamięta, który opis był otwarty, i przywraca go po odświeżeniu.
 *
 * Wiersz listy musi mieć `data-item-id` (przedmiot aktora z kontekstu) albo
 * `data-item-uuid` (przedmiot spoza aktora: kompendium, katalog przedmiotów świata)
 * i dziecko `.item-summary`.
 */
import {
  itemModifier, bookPrice, basePrice, modifiedPackCopper, getCustomPrice, coinsIn, unitDenomination,
  getAmmoTypeLabel, getRuneUsageLabel, isMerchantActor
} from "../shop-data.js";

/** Klasa renderera opisów PF2e, zapamiętana z karty PF2e (karta sklepu albo postaci). */
let RendererClass = null;

/** Zapamiętuje klasę renderera opisów z karty PF2e (wywoływane przy renderowaniu karty sklepu). */
export function rememberSummaryRenderer(sheet) {
  RendererClass ??= sheet?.itemRenderer?.constructor ?? null;
}

/** Klucz wiersza (do zapamiętania otwartego opisu). */
function rowKey(row) {
  return row?.dataset.itemUuid ?? row?.dataset.itemId ?? null;
}

/** Przedmiot z wiersza: po UUID albo z przedmiotów aktora z kontekstu. */
async function itemOf(row, context) {
  if (row.dataset.itemUuid) return fromUuid(row.dataset.itemUuid).catch(() => null);
  return context.actor?.items?.get(row.dataset.itemId) ?? null;
}

/** Wypełnia pusty kontener opisu: szablon PF2e + dodatki modułu. */
async function fillSummary(container, item, context) {
  // Zaklęcie spoza aktora (przeglądarka list, „Lista zaklęć”): PF2e nie buduje dla niego
  // pełnego opisu (`getChatData` wymaga właściciela), więc składamy go z części PF2e w tym
  // samym układzie co opis przedmiotu.
  if (item?.type === "spell" && !item.actor) {
    container.innerHTML = await spellSummaryHTML(item);
    return;
  }
  const Renderer = RendererClass ?? context.actor?.sheet?.itemRenderer?.constructor ?? null;
  let rendered = false;
  if (Renderer && item?.getChatData) {
    try {
      const renderer = new Renderer({ actor: item.actor ?? context.actor ?? null });
      const chatData = await item.getChatData({ secrets: item.isOwner }, { ...container.parentElement?.dataset });
      await renderer.renderItemSummary(container, item, chatData);
      rendered = true;
    } catch (error) {
      console.warn("PSM | opis PF2e niedostępny, pokazuję sam opis", error);
    }
  }
  if (!rendered) {
    // Bez renderera PF2e (albo gdy PF2e nie zbuduje opisu): sam opis przedmiotu.
    container.innerHTML = `<div class="description">${await enrich(item)}</div>`;
  }
  decorateSummary(container, item, context);
}

/**
 * Opis zaklęcia bez aktora, w układzie szablonu opisu PF2e (`item-summary.hbs`), więc ze
 * stylami PF2e jak przy przedmiotach:
 * - tagi: rzadkość (poza common) i cechy zaklęcia (`traitChatData` PF2e, z podpowiedziami),
 * - opis z nagłówkiem PF2e (`getDescriptionData`: tradycje, rzucanie, zasięg, obszar,
 *   obrona, czas trwania…) i rozwiniętymi odnośnikami.
 * Gdy PF2e czegoś nie zbuduje — sam opis zaklęcia.
 */
async function spellSummaryHTML(spell) {
  const esc = (text) => foundry.utils.escapeHTML?.(String(text ?? "")) ?? String(text ?? "");
  try {
    const tags = [];
    const rarity = spell.rarity ?? spell.system?.traits?.rarity ?? "common";
    if (rarity !== "common") {
      const label = game.i18n.localize(CONFIG.PF2E?.rarityTraits?.[rarity] ?? rarity);
      const tip = game.i18n.localize(CONFIG.PF2E?.traitsDescriptions?.[rarity] ?? "");
      tags.push(`<span class="tag rarity ${esc(rarity)}" data-tooltip="${esc(tip)}">${esc(label)}</span>`);
    }
    for (const trait of spell.traitChatData?.(CONFIG.PF2E?.spellTraits) ?? []) {
      tags.push(`<span class="tag" data-tooltip="${esc(game.i18n.localize(trait.description ?? ""))}">${esc(game.i18n.localize(trait.label))}</span>`);
    }
    const data = await spell.getDescriptionData();
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    const description = await TextEditor.enrichHTML(data?.value ?? "", { relativeTo: spell });
    return `${tags.length ? `<div class="tags paizo-style">${tags.join("")}</div>` : ""}<div class="description">${description}</div>`;
  } catch (error) {
    console.warn("PSM | opis zaklęcia z PF2e niedostępny, pokazuję sam opis", error);
    return `<div class="description">${await enrich(spell)}</div>`;
  }
}

/** Opis przedmiotu z rozwiniętymi odnośnikami i rzutami. */
async function enrich(item) {
  const TextEditor = foundry.applications.ux.TextEditor.implementation;
  return TextEditor.enrichHTML(item?.description ?? item?.system?.description?.value ?? "", { relativeTo: item });
}


/**
 * Dodatki modułu w opisie: cena sklepu (gdy przedmiot leży w sklepie), typ amunicji
 * i użycie runy pod ceną.
 */
function decorateSummary(container, item, context) {
  const shop = context.shop ?? (isMerchantActor(item?.actor) ? item.actor : null);
  if (shop) replaceSummaryPrice(container, item, shop);

  const lines = [];
  const ammoType = getAmmoTypeLabel(item);
  if (ammoType) lines.push(game.i18n.format("PF2E_SHOP.Inventory.AmmoTypeLine", { type: ammoType }));
  const runeUsage = getRuneUsageLabel(item);
  if (runeUsage) lines.push(game.i18n.format("PF2E_SHOP.Inventory.UsageLine", { usage: runeUsage }));
  if (!lines.length) return;
  // Blok "Item X / Price: Y" to pierwsza sekcja opisu, która nie jest notatką MG.
  const priceBlock = [...container.querySelectorAll(":scope > section")].find((el) => !el.classList.contains("gm-notes"));
  for (const text of lines) {
    const line = document.createElement("div");
    line.className = "psm-ammo-type";
    line.textContent = text;
    if (priceBlock) priceBlock.append(line);
    else container.querySelector(":scope > .description")?.before(line);
  }
  if (ammoType) removeAmmunitionParagraph(container.querySelector(":scope > .description"));
}

/**
 * PF2e wpisuje do opisu cenę z podręcznika (bez mnożnika i własnej ceny). W sklepie
 * podmieniamy ją na cenę po mnożniku, tę samą co w wierszu i przy zakupie.
 */
function replaceSummaryPrice(container, item, shop) {
  const priceModifier = itemModifier(shop, item);
  const book = bookPrice(item);
  const base = basePrice(item);
  if (!book?.value?.toString || !base?.value) return;
  const per = Math.max(1, book.per ?? 1);
  const suffix = per > 1 ? ` / ${per}` : "";
  const from = `${book.value.toString()}${suffix}`;
  const Coins = book.value.constructor;
  const copper = modifiedPackCopper(base, priceModifier);
  const custom = getCustomPrice(item);
  const modified = custom ? new Coins(coinsIn(copper, unitDenomination(custom))) : new Coins({ cp: copper });
  const to = `${(custom ? modified : (modified.normalized?.() ?? modified)).toString()}${suffix}`;
  if (from === to) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(".description, .gm-notes")) continue;
    if (node.nodeValue.includes(from)) {
      node.nodeValue = node.nodeValue.replace(from, to);
      return;
    }
  }
}

/** Nagłówek akapitu "Ammunition …" w opisach z kompendium (także w tłumaczeniu). */
const AMMUNITION_HEADING = /^(ammunition|amunicja)$/i;

/**
 * Usuwa z wyświetlanego opisu akapit "<strong>Ammunition</strong> any" z kompendium,
 * bo typ amunicji pokazujemy wyżej, w bloku z ceną. Zmienia tylko to, co widać;
 * dane przedmiotu zostają bez zmian.
 */
function removeAmmunitionParagraph(description) {
  const first = description?.firstElementChild;
  if (first?.tagName !== "P") return;
  const heading = first.firstElementChild;
  if (heading?.tagName !== "STRONG" || !AMMUNITION_HEADING.test(heading.textContent.trim())) return;
  const before = [...first.childNodes].slice(0, [...first.childNodes].indexOf(heading));
  if (before.some((node) => node.textContent.trim())) return;
  const next = first.nextElementSibling;
  first.remove();
  if (next?.tagName === "HR") next.remove();
}

/** Pokazuje albo chowa kontener opisu (z animacją jak w PF2e, chyba że `instant`). */
async function setVisible(container, show, instant) {
  const gsap = globalThis.gsap;
  if (instant || !gsap) {
    container.hidden = !show;
    return;
  }
  // 0,2 s — wybrane w teście w Foundry 21.10.2026 (0,4 s wyglądało na mniej płynne).
  const duration = 0.2;
  if (show) {
    if (!container.hidden) return;
    await gsap.fromTo(container, { height: 0, opacity: 0, hidden: false }, { height: "auto", opacity: 1, duration });
  } else {
    await gsap.to(container, {
      height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, margin: 0, duration, clearProps: "all",
      onComplete: () => (container.hidden = true)
    });
  }
}

/**
 * Przełącza opis przedmiotu w wierszu. W tej samej liście jest otwarty najwyżej
 * jeden opis. Zwraca klucz otwartego opisu (do zapamiętania w oknie) albo null.
 * @param {HTMLElement} row      wiersz z `data-item-id` albo `data-item-uuid`
 * @param {object} [context]
 * @param {Actor} [context.actor]  właściciel przedmiotów z `data-item-id`
 * @param {Actor} [context.shop]   sklep, którego cenę pokazać (domyślnie aktor przedmiotu, jeśli to sklep)
 * @param {boolean} [context.visible]  wymuś stan (true/false) zamiast przełączania
 * @param {boolean} [context.instant]  bez animacji
 */
export async function toggleSummary(row, context = {}) {
  const container = row?.querySelector(":scope > .item-summary");
  if (!container) return null;
  const show = context.visible ?? container.hidden;

  if (show) {
    const list = row.parentElement;
    for (const open of list?.querySelectorAll(":scope > * > .item-summary:not([hidden])") ?? []) {
      if (open !== container) await setVisible(open, false, true);
    }
    if (!container.hasChildNodes()) {
      const item = await itemOf(row, context);
      if (!item) return null;
      await fillSummary(container, item, context);
    }
  }
  await setVisible(container, show, context.instant);
  return show ? rowKey(row) : null;
}

/** Po odświeżeniu okna otwiera z powrotem opis, który był rozwinięty. */
export async function restoreSummary(root, key, context = {}) {
  if (!key) return;
  const row = [...root.querySelectorAll("[data-item-uuid], [data-item-id]")].find((el) => rowKey(el) === key && el.querySelector(":scope > .item-summary"));
  if (row) await toggleSummary(row, { ...context, visible: true, instant: true });
}
