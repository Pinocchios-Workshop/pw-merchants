/**
 * Oznaczenia w polu wyszukiwania (opis: SEARCH.md, „Oznaczenia w polu wyszukiwania”).
 *
 * Wpisany znacznik „klucz:x” (każdy klucz z `SEARCH_KEYS`, także grupa „lub”, np.
 * `trait:acid|fire`) po spacji, Enterze albo opuszczeniu pola zamienia się w oznaczenie
 * z etykietą z PF2e (np. `weapon-category:simple` → „Simple Weapon”). Cecha i rzadkość mają
 * własne kolory, pozostałe klucze — wspólny prosty styl. Grupa „lub” to jedno oznaczenie z częściami
 * rozdzielonymi „|”. Dwuklik na oznaczeniu wraca do tekstu do edycji; Backspace w pustym
 * polu edytuje ostatnie oznaczenie; × usuwa oznaczenie.
 *
 * Oznaczenia są tylko widokiem: stan filtrów to nadal jeden tekst wyszukiwania
 * (`state.search`), który składa się z oznaczeń (ich tekstu źródłowego) i reszty pola.
 * Logika dopasowania bez zmian (`parseSearch` / `matches` w filters.js).
 */
import { RARITY_COLORS } from "../constants.js";
import { normalizeTag, parseTerm, parseGroup, SEARCH_KEYS, keyAcceptsLabels } from "./filters.js";

/**
 * Klucze zamieniane na oznaczenia: wszystkie klucze wyszukiwania. Sprawdzane w trakcie
 * działania (filters.js i ten plik importują się wzajemnie, więc bez odczytu przy wczytaniu).
 */
const isChipKey = (key) => SEARCH_KEYS.includes(key);

/** Słowniki `CONFIG.PF2E` z wartościami i etykietami kluczy szczegółów (jak `DETAIL_FIELDS` w shop-data.js). */
const KEY_DICTS = Object.freeze({
  "weapon-category": "weaponCategories",
  "weapon-group": "weaponGroups",
  "weapon-base": "baseWeaponTypes",
  "armor-group": "armorGroups",
  "armor-base": "baseArmorTypes",
  "shield-base": "baseShieldTypes",
  "spell-tradition": "magicTraditions",
  "armor-category": "armorCategories",
  "consumable-category": "consumableCategories",
  "ammunition-type": "ammoTypes"
});

/** Nazwy w `type:x` → typ przedmiotu PF2e (odwrotność `SEARCH_TYPES` w shop-data.js). */
const TYPE_NAMES = Object.freeze({
  ammunition: "ammo", armor: "armor", consumable: "consumable", container: "backpack", equipment: "equipment",
  kit: "kit", shield: "shield", treasure: "treasure", weapon: "weapon"
});

const keyLabels = new Map();
/**
 * Etykieta wartości klucza w języku gry albo null, gdy PF2e jej nie zna. Mapa
 * (znormalizowana nazwa systemowa i etykieta → etykieta) budowana raz na klucz.
 */
function keyLabel(key, value) {
  if (!keyLabels.has(key)) {
    const map = new Map();
    // Klucze tylko z wartościami bazowymi (`labels: false`): etykieta jest wyświetlana, ale
    // wpisana etykieta („martial-weapon”) nie jest rozpoznana.
    const labels = keyAcceptsLabels(key);
    const add = (slug, labelKey) => {
      const label = labelKey ? game.i18n.localize(labelKey) : slug;
      map.set(normalizeTag(slug), label);
      if (labels) map.set(normalizeTag(label), label);
    };
    const config = globalThis.CONFIG?.PF2E ?? {};
    if (key === "type") {
      for (const [name, type] of Object.entries(TYPE_NAMES)) {
        const label = game.i18n.localize(globalThis.CONFIG?.Item?.typeLabels?.[type] ?? `TYPES.Item.${type}`);
        add(name, label.startsWith("TYPES.") ? name.charAt(0).toUpperCase() + name.slice(1) : label);
      }
    } else {
      for (const [slug, entry] of Object.entries(config[KEY_DICTS[key]] ?? {})) add(slug, typeof entry === "string" ? entry : entry?.label);
    }
    keyLabels.set(key, map);
  }
  return keyLabels.get(key).get(value) ?? null;
}
const RARITIES = ["common", "uncommon", "rare", "unique"];
const TRAIT_DICTS = ["weaponTraits", "armorTraits", "shieldTraits", "consumableTraits", "equipmentTraits", "spellTraits"];

let traitLabels = null;
/** Etykiety cech przedmiotów PF2e: znormalizowana nazwa systemowa albo etykieta → etykieta. */
function traitLabel(value) {
  if (!traitLabels) {
    traitLabels = new Map();
    const config = globalThis.CONFIG?.PF2E ?? {};
    for (const name of TRAIT_DICTS) {
      for (const [slug, key] of Object.entries(config[name] ?? {})) {
        if (RARITIES.includes(slug)) continue;
        const label = game.i18n.localize(key);
        traitLabels.set(normalizeTag(slug), label);
        traitLabels.set(normalizeTag(label), label);
      }
    }
  }
  return traitLabels.get(value) ?? null;
}

/**
 * Etykieta zasięgu broni: „melee” → „Melee” (tłumaczenie modułu), liczba stóp → „60 ft.”
 * (tekst PF2e z karty broni). Każda dodatnia liczba jest poprawna (także zasięgi spoza karty).
 */
function rangeLabel(value) {
  if (value === "melee") return { label: game.i18n.localize("PF2E_SHOP.Filters.Melee"), known: true };
  if (!/^[1-9]\d*$/.test(value)) return { label: value, known: false };
  const label = game.i18n.format?.("PF2E.WeaponRangeN", { range: value });
  return { label: label && label !== "PF2E.WeaponRangeN" ? label : `${value} ft.`, known: true };
}

/** Etykieta premii do AC: „4” → „+4 AC”. Każda nieujemna liczba całkowita jest poprawna. */
function acLabel(value) {
  return /^(0|[1-9]\d*)$/.test(value) ? { label: `+${value} AC`, known: true } : { label: value, known: false };
}

/** Część oznaczenia: { key, value, label, known } ze znacznika „klucz:wartość”. */
function chipPart(tag) {
  const colon = tag.indexOf(":");
  const key = tag.slice(0, colon);
  const value = tag.slice(colon + 1);
  if (key === "weapon-range") return { key, value, ...rangeLabel(value) };
  if (key === "armor-class" || key === "shield-class") return { key, value, ...acLabel(value) };
  if (key === "rarity") {
    const known = RARITIES.includes(value);
    const label = known ? game.i18n.localize(globalThis.CONFIG?.PF2E?.rarityTraits?.[value] ?? value) : value;
    return { key, value, label, known };
  }
  const label = key === "trait" ? traitLabel(value) : keyLabel(key, value);
  return { key, value, label: label ?? value, known: !!label };
}

/**
 * Oznaczenie ze słowa wyszukiwania albo null, gdy słowa nie zamieniamy (zwykły tekst,
 * inny klucz, błędny zapis grupy). Słowo z „!” na początku („!rarity:rare”, operator NOT)
 * to to samo oznaczenie, narysowane jako przekreślone (`negated`). „!” zamieniamy tylko przy
 * pojedynczym znaczniku: „!of” (nazwa) i „!trait:acid|fire” („!” z „|” — operatorów nie
 * łączymy) zostają zwykłym tekstem.
 * @returns {{ raw: string, negated: boolean, parts: object[] }|null}
 */
export function chipOf(word) {
  const negated = word.startsWith("!");
  const body = negated ? word.slice(1) : word;
  if (negated && body.includes("|")) return null;
  const terms = body.includes("|") ? parseGroup(body) : [parseTerm(body)];
  if (!terms?.length || terms.some((t) => !t?.tag || !isChipKey(t.tag.slice(0, t.tag.indexOf(":"))))) return null;
  return { raw: word, negated, parts: terms.map((t) => chipPart(t.tag)) };
}

/**
 * Oznaczenie jako sam podgląd (bez edycji i ×) — np. w Syntax Guide: „wartość → oznaczenie”.
 * Ten sam wygląd i te same etykiety co w polu wyszukiwania. null, gdy słowo nie jest znacznikiem.
 */
export function searchTagPreview(word) {
  const chip = chipOf(word);
  return chip ? chipElement(chip, { preview: true }) : null;
}

/** Element oznaczenia (`preview`: bez edycji, fokusu i ×). */
function chipElement(chip, { preview = false } = {}) {
  const el = document.createElement("span");
  // `psm-qtag--not`: operator NOT (!) — ten sam wygląd, część oznaczenia przekreślona (shop.css).
  el.className = `psm-qtag${chip.parts.length > 1 ? " psm-qtag--or" : ""}${chip.negated ? " psm-qtag--not" : ""}${preview ? " psm-qtag--preview" : ""}`;
  if (!preview) {
    el.dataset.searchChip = chip.raw;
    el.tabIndex = 0;
    el.dataset.psmTooltip = `${chip.raw} — ${game.i18n.localize("PF2E_SHOP.Filters.ChipEdit")}`;
  }
  chip.parts.forEach((part, i) => {
    if (i) {
      const or = document.createElement("span");
      or.className = "psm-qtag__or";
      or.textContent = "|";
      el.append(or);
    }
    const p = document.createElement("span");
    // Cecha i rzadkość mają własne kolory; pozostałe klucze — wspólny prosty styl.
    const style = part.key === "trait" || part.key === "rarity" ? part.key : "plain";
    p.className = `psm-qtag__part psm-qtag__part--${style}${part.known ? "" : " psm-qtag__part--unknown"}`;
    p.dataset.key = part.key;
    if (part.key === "rarity" && part.known) p.dataset.rarity = part.value;
    const color = part.key === "rarity" ? RARITY_COLORS[part.value] : null;
    if (color) p.style.setProperty("--psm-qtag-color", color);
    p.textContent = part.label;
    el.append(p);
  });
  if (preview) return el;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "psm-qtag__remove";
  remove.dataset.searchChipRemove = "";
  remove.setAttribute("aria-label", game.i18n.localize("PF2E_SHOP.Filters.ChipRemove"));
  remove.innerHTML = '<i class="fa-solid fa-xmark" inert></i>';
  el.append(remove);
  return el;
}

/**
 * Podpina oznaczenia pod pole wyszukiwania paska filtrów.
 * @param {HTMLInputElement} input   pole `[data-filter="search"]`
 * @param {() => void} onChange      wywoływane, gdy zmieni się zestaw oznaczeń
 * @returns {{ value: () => string, set: (search: string) => void }}
 */
export function activateSearchChips(input, onChange) {
  const box = input.closest(".psm-search");
  let list = box.querySelector(":scope > [data-search-chips]");
  if (!list) {
    list = document.createElement("span");
    list.className = "psm-search__chips";
    list.dataset.searchChips = "";
    input.before(list);
  }
  const chips = () => [...list.querySelectorAll(":scope > [data-search-chip]")];

  /** Pełny tekst wyszukiwania: oznaczenia + reszta pola. */
  const value = () => [...chips().map((el) => el.dataset.searchChip), input.value.trim()].filter(Boolean).join(" ");

  /** Zamienia gotowe słowa pola na oznaczenia (`keepLast`: ostatnie słowo jeszcze się pisze). */
  const convert = (keepLast = false) => {
    const words = input.value.split(/\s+/).filter(Boolean);
    const last = keepLast && !/\s$/.test(input.value) ? words.pop() : null;
    const rest = [];
    let added = false;
    for (const word of words) {
      const chip = chipOf(word);
      if (chip) {
        list.append(chipElement(chip));
        added = true;
      } else rest.push(word);
    }
    if (!added) return false;
    input.value = [...rest, ...(last ? [last] : [])].join(" ") + (rest.length && !last ? " " : "");
    return true;
  };

  /** Oznaczenie z powrotem jako tekst do edycji (na początku pola, kursor za nim). */
  const edit = (el) => {
    const raw = el.dataset.searchChip;
    el.remove();
    const text = input.value.trim();
    input.value = text ? `${raw} ${text}` : raw;
    input.focus();
    input.setSelectionRange(raw.length, raw.length);
    onChange();
  };

  const set = (search) => {
    list.replaceChildren();
    input.value = String(search ?? "");
    convert();
    input.value = input.value.trim();
  };

  input.addEventListener("input", (event) => {
    // Spacja kończy słowo: gotowe znaczniki zamieniają się w oznaczenia.
    if (event.data === " " || /\s$/.test(input.value)) {
      if (convert()) onChange();
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") convert();
    if (event.key === "Backspace" && !input.value && input.selectionStart === 0) {
      const last = chips().at(-1);
      if (last) {
        event.preventDefault();
        edit(last);
      }
    }
  });
  input.addEventListener("blur", () => {
    if (convert()) onChange();
  });
  list.addEventListener("dblclick", (event) => {
    const el = event.target.closest("[data-search-chip]");
    if (el) edit(el);
  });
  list.addEventListener("keydown", (event) => {
    const el = event.target.closest("[data-search-chip]");
    if (!el || event.target.closest("[data-search-chip-remove]")) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      edit(el);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      el.remove();
      input.focus();
      onChange();
    }
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-search-chip-remove]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    button.closest("[data-search-chip]")?.remove();
    onChange();
  });
  // Kliknięcie w wolne miejsce ramki ustawia kursor w polu.
  box.addEventListener("mousedown", (event) => {
    if (event.target === box || event.target === list) {
      event.preventDefault();
      input.focus();
    }
  });
  return { value, set };
}
