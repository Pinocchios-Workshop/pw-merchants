/**
 * Syntax Guide — okno pomocy do składni wyszukiwania (ApplicationV2), otwierane ikoną „?”
 * przy każdym polu wyszukiwania (karta sklepu, przeglądarka list towaru). Design ustalony
 * 22.10.2026 (PLAN.md): ostrzeżenie „Early development”, przyciski tematów, podkategorie
 * (opis 2/3, przykłady 1/3 — na razie nieklikalne), rozwijane „All values”
 * (`wartość → oznaczenie`) i stopka z podziękowaniem dla Scryfall.
 *
 * Treść: klucze tłumaczeń `PF2E_SHOP.SyntaxGuide.*` (treść tylko po angielsku — składnia jest
 * angielska; Foundry pokazuje angielski tekst, gdy brak tłumaczenia). Wartości kluczy brane
 * z PF2e w trakcie działania (`CONFIG.PF2E`), oznaczenia — tym samym kodem co w polu
 * wyszukiwania (`searchTagPreview`), więc wyglądają i nazywają się tak samo.
 */
import { TEMPLATES, MODULE_ID, WEAPON_RANGES, ARMOR_AC_BONUSES, SHIELD_AC_BONUSES } from "../constants.js";
import { SEARCH_TYPES } from "../shop-data.js";
import { searchTagPreview } from "../sheets/search-chips.js";
import { renderValues } from "./guide-values.js";
import { windowSize } from "../window-sizes.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const RARITIES = ["common", "uncommon", "rare", "unique"];
const ITEM_TRAITS = ["weaponTraits", "armorTraits", "shieldTraits", "consumableTraits", "equipmentTraits"];
/** Wszystkie cechy do wyszukania: przedmioty i zaklęcia (`trait:` działa w obu listach). */
const ALL_TRAITS = [...ITEM_TRAITS, "spellTraits"];

/**
 * Tematy i podkategorie. `examples`: liczba przykładów (teksty w tłumaczeniach: ExN.Query /
 * ExN.Text); `note`: ramka „Creator info” pod opisem (tekst: Note); `values`: klucz wyszukiwania i źródło wartości (słowniki `CONFIG.PF2E` albo
 * stała lista) dla „All values”.
 */
const TOPICS = [
  { id: "basics", icon: "fa-font", intro: true, sections: [
    { id: "filters", examples: 2 },
    { id: "type", examples: 3, values: { key: "type", list: () => [...new Set(Object.values(SEARCH_TYPES))] } },
    { id: "tags", examples: 0 }
  ] },
  { id: "logic", icon: "fa-code-branch", intro: true, sections: [
    { id: "and", examples: 2 },
    { id: "or", examples: 3 },
    { id: "not", examples: 2 },
    { id: "combine", examples: 1 }
  ] },
  { id: "traits", icon: "fa-tags", intro: true, sections: [
    { id: "trait", examples: 2, values: { key: "trait", dicts: ALL_TRAITS } }
  ] },
  { id: "rarity", icon: "fa-gem", intro: true, sections: [
    { id: "rarity", examples: 2, values: { key: "rarity", list: () => RARITIES } }
  ] },
  { id: "weapons", icon: "fa-sword", sections: [
    { id: "category", examples: 2, values: { key: "weapon-category", dicts: ["weaponCategories"] } },
    { id: "group", examples: 2, values: { key: "weapon-group", dicts: ["weaponGroups"] } },
    { id: "base", examples: 2, values: { key: "weapon-base", dicts: ["baseWeaponTypes"] } },
    { id: "range", examples: 2, note: true, values: { key: "weapon-range", list: () => ["melee", ...WEAPON_RANGES.map(String)] } }
  ] },
  { id: "armor", icon: "fa-shirt", sections: [
    { id: "category", examples: 2, values: { key: "armor-category", dicts: ["armorCategories"] } },
    { id: "group", examples: 2, values: { key: "armor-group", dicts: ["armorGroups"] } },
    { id: "base", examples: 2, values: { key: "armor-base", dicts: ["baseArmorTypes"] } },
    { id: "class", examples: 2, values: { key: "armor-class", list: () => ARMOR_AC_BONUSES.map(String) } }
  ] },
  { id: "shields", icon: "fa-shield-halved", sections: [
    { id: "class", examples: 2, values: { key: "shield-class", list: () => SHIELD_AC_BONUSES.map(String) } },
    { id: "base", examples: 2, values: { key: "shield-base", dicts: ["baseShieldTypes"] } }
  ] },
  { id: "consumables", icon: "fa-flask", sections: [
    { id: "category", examples: 2, values: { key: "consumable-category", dicts: ["consumableCategories"] } }
  ] },
  { id: "ammunition", icon: "fa-bullseye", sections: [
    { id: "type", examples: 2, values: { key: "ammunition-type", dicts: ["ammoTypes"] } }
  ] },
  { id: "spells", icon: "fa-scroll", sections: [
    { id: "tradition", examples: 2, values: { key: "spell-tradition", dicts: ["magicTraditions"] } }
  ] }
];

/** Wartości klucza dla „All values”: nazwy systemowe, alfabetycznie, liczby rosnąco (cechy bez rzadkości). */
function valuesOf(spec) {
  if (spec.list) return spec.list();
  const config = CONFIG.PF2E ?? {};
  const slugs = new Set();
  for (const dict of spec.dicts ?? []) for (const slug of Object.keys(config[dict] ?? {})) slugs.add(slug);
  return [...slugs].filter((s) => spec.key !== "trait" || !RARITIES.includes(s)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export class SyntaxGuide extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Otwiera okno (jedno na klienta) albo przywołuje już otwarte. */
  static open() {
    const existing = foundry.applications.instances.get(`${MODULE_ID}-syntax-guide`);
    if (existing) return existing.bringToFront();
    const app = new this();
    app.render({ force: true });
    return app;
  }

  constructor(options = {}) {
    super(foundry.utils.mergeObject({ position: windowSize("syntaxGuide", { center: true }) }, options, { inplace: false }));
    /** Wybrany temat (przycisk na górze). */
    this.topic = "basics";
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-syntax-guide`,
    tag: "div",
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-guide-window"],
    window: { icon: "fa-solid fa-circle-question", resizable: true },
    actions: { topic: SyntaxGuide.#onTopic }
  };

  static PARTS = {
    form: { template: TEMPLATES.syntaxGuide, scrollable: [".psm-guide"] }
  };

  get title() {
    return game.i18n.localize("PF2E_SHOP.SyntaxGuide.Title");
  }

  async _prepareContext() {
    const t = (key) => game.i18n.localize(`PF2E_SHOP.SyntaxGuide.${key}`);
    const topic = TOPICS.find((x) => x.id === this.topic) ?? TOPICS[0];
    return {
      topics: TOPICS.map((x) => ({ id: x.id, icon: x.icon, label: t(`Topics.${x.id}`), active: x.id === topic.id })),
      // Opis tematu nad podkategoriami (np. Basics: czym jest wyszukiwarka i jak czytać ten przewodnik).
      intro: topic.intro ? t(`${topic.id}.Intro`) : null,
      sections: topic.sections.map((section) => {
        const base = `${topic.id}.${section.id}`;
        return {
          title: t(`${base}.Title`),
          // Treść z tłumaczeń (HTML z <code>, <b>) — tylko teksty modułu.
          text: t(`${base}.Text`),
          note: section.note ? t(`${base}.Note`) : null,
          examples: Array.from({ length: section.examples }, (_, i) => ({
            query: t(`${base}.Ex${i + 1}.Query`),
            text: t(`${base}.Ex${i + 1}.Text`)
          })),
          values: section.values
            ? { ref: `${topic.id}:${section.id}`, count: valuesOf(section.values).length }
            : null
        };
      })
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    // Przykładowe oznaczenia w tekście (`<span data-guide-tag="trait:acid">`) — rysowane tym samym
    // kodem co w polu wyszukiwania.
    for (const slot of this.element.querySelectorAll("[data-guide-tag]")) {
      const tag = searchTagPreview(slot.dataset.guideTag);
      if (tag) slot.replaceChildren(tag);
    }
    // „All values” wypełniane przy pierwszym rozwinięciu (cech bywa kilkaset).
    for (const details of this.element.querySelectorAll("[data-guide-values]")) {
      details.addEventListener("toggle", () => {
        if (!details.open || details.dataset.filled) return;
        details.dataset.filled = "1";
        const [topicId, sectionId] = details.dataset.guideValues.split(":");
        const spec = TOPICS.find((x) => x.id === topicId)?.sections.find((s) => s.id === sectionId)?.values;
        renderValues(details.querySelector(".psm-guide__values"), valuesOf(spec ?? {}), spec?.key);
      });
    }
  }

  /** Przycisk tematu: pokazuje podkategorie wybranego tematu. */
  static #onTopic(event, target) {
    this.topic = target.dataset.topic;
    this.render();
  }
}
