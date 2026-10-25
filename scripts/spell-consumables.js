/**
 * Zwoje i różdżki z zaklęć dla list towaru (tryb „Lista zaklęć” w przeglądarce list).
 *
 * Pozycja listy ze zwojem albo różdżką to zwykła pozycja z polem `scroll: { rank }` albo
 * `wand: { rank }` i UUID zaklęcia (nie przedmiotu): nazwa „Scroll of X (Rank N)” /
 * „Wand of X (Rank N)”, obrazek i poziom bazowego zwoju / różdżki tej rangi.
 * Przy losowaniu przedmiot jest tworzony tak jak w PF2e (`createConsumableFromSpell`, którego
 * system nie udostępnia modułom): bazowy zwój / różdżka rangi N z kompendium PF2e
 * (`CONFIG.PF2E.spellcastingItems.scroll` / `.wand`) + zaklęcie na tej randze w `system.spell`,
 * cechy zaklęcia, rzadkość zaklęcia i nazwa z szablonu PF2e.
 */

/** Formy przedmiotu z zaklęcia — pole pozycji listy = nazwa formy. */
export const SPELL_FORMS = Object.freeze(["scroll", "wand"]);

/** Forma i ranga pozycji listy ({ form, rank }) albo null dla zwykłego przedmiotu. */
export function spellFormOf(entry) {
  for (const form of SPELL_FORMS) if (entry?.[form]?.rank) return { form, rank: entry[form].rank };
  return null;
}

/** Dane formy z PF2e: szablon nazwy i UUID bazowych przedmiotów rang 1–10 (różdżki 1–9). */
function formConfig(form) {
  return CONFIG.PF2E?.spellcastingItems?.[form] ?? null;
}

/** UUID bazowego zwoju / różdżki danej rangi (kompendium PF2e) albo null, gdy takiej nie ma. */
export function formBaseUuid(form, rank) {
  return formConfig(form)?.compendiumUuids?.[rank] ?? null;
}

/** Najwyższa ranga formy w PF2e (zwoje 10, różdżki 9). */
export function formMaxRank(form) {
  const ranks = Object.entries(formConfig(form)?.compendiumUuids ?? {}).filter(([, uuid]) => uuid).map(([r]) => Number(r));
  return ranks.length ? Math.max(...ranks) : form === "wand" ? 9 : 10;
}

/** Nazwa jak w PF2e: „Scroll of Fireball (Rank 3)”, „Wand of Fireball (Rank 3)”. */
export function formName(form, spellName, rank) {
  const template = formConfig(form)?.nameTemplate;
  if (template) return game.i18n.format(template, { name: spellName, level: rank });
  return `${form === "wand" ? "Wand" : "Scroll"} of ${spellName} (Rank ${rank})`;
}

/** Ranga przedmiotu dla zaklęcia: wybrana w panelu (nie niższa niż ranga bazowa zaklęcia, najmniej 1). */
export function formRank(spellLevel, chosen, max = 10) {
  const base = Math.max(1, Number(spellLevel) || 1);
  const rank = Number(chosen) || base;
  return Math.min(max, Math.max(base, rank));
}

/**
 * Czy zaklęcie można zapisać na zwoju / w różdżce rangi `rank`: ranga bazowa, a wyżej tylko
 * tam, gdzie zaklęcie się podwyższa — co `interval` rang (np. Fireball co 1: każda wyższa
 * ranga) albo na wymienionych rangach (np. Airburst: 1 i 4). Bez podwyższania — tylko ranga bazowa.
 * @param {number} baseRank
 * @param {{ interval?: number, ranks?: number[] }|null} heighten
 */
export function canCastAtRank(baseRank, heighten, rank) {
  const base = Math.max(1, Number(baseRank) || 1);
  if (rank === base) return true;
  if (rank < base) return false;
  // Interwał i konkretne rangi mogą wystąpić razem (zakładka + opis) — wystarczy jedno.
  if (heighten?.interval && (rank - base) % heighten.interval === 0) return true;
  return !!heighten?.ranks?.includes(rank);
}

/** Poziom przedmiotu rangi N, gdy bazowego nie ma w indeksie (PF2e: zwój 2N−1, różdżka 2N+1). */
export function formLevel(form, rank) {
  return form === "wand" ? rank * 2 + 1 : Math.max(1, rank * 2 - 1);
}

/**
 * Dane źródłowe zwoju / różdżki z zaklęcia — jak `createConsumableFromSpell` w PF2e.
 * @param {Item} spell  dokument zaklęcia
 * @param {"scroll"|"wand"} form
 * @param {number} rank
 * @returns {Promise<object|null>} źródło przedmiotu (bez `_id`) albo null, gdy brak bazowego przedmiotu
 */
export async function spellConsumableSource(spell, form, rank) {
  const uuid = formBaseUuid(form, rank);
  const base = uuid ? await fromUuid(uuid).catch(() => null) : null;
  if (!spell || !base || base.type !== "consumable") return null;
  const source = base.toObject();
  delete source._id;

  // Cechy: przedmiotu + zaklęcia, rzadkość zaklęcia; „magical” znika, gdy jest tradycja magii.
  const traits = source.system.traits;
  const traditions = Object.keys(CONFIG.PF2E?.magicTraditions ?? {});
  traits.value = [...new Set([...(traits.value ?? []), ...(spell.system?.traits?.value ?? [])])];
  traits.rarity = spell.rarity ?? spell.system?.traits?.rarity ?? "common";
  if (traits.value.includes("magical") && traits.value.some((t) => traditions.includes(t))) {
    traits.value.splice(traits.value.indexOf("magical"), 1);
  }
  traits.value.sort();

  source.name = formName(form, spell.name, rank);
  const sourceId = spell.sourceId ?? spell.uuid;
  const link = sourceId ? `@UUID[${sourceId}]{${spell.name}}` : spell.description ?? "";
  source.system.description.value = `<p>${link}</p><hr />${source.system.description.value ?? ""}`;
  source.system.spell = foundry.utils.mergeObject(
    spell.toObject?.() ?? spell._source,
    { _id: foundry.utils.randomID(), system: { location: { value: null, heightenedLevel: rank } } },
    { inplace: false }
  );
  source._stats ??= {};
  source._stats.compendiumSource = uuid;
  return source;
}
