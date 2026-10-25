/**
 * Losowanie towaru z listy towaru modułu (zamiast tabel losowych Foundry).
 *
 * Czysta logika (bez Foundry poza odczytem poziomu drużyny), żeby dało się ją testować
 * i stroić. Zwraca pozycje listy z liczbą sztuk; zamianę na przedmioty robi `randomizer.js`.
 *
 * Tryb „Ręczne wagi” (`manual`): każde losowanie ze zwracaniem według wag pozycji.
 *
 * Tryb „Według poziomu postaci” (`partyLevel`, ustalone 21.10.2026, PLAN.md):
 * - poziomy ≤ poziomu drużyny: waga × 0,8 za każdy poziom niżej,
 * - +1 i +2: stała szansa na losowanie (6% i 1,5%), +3 i wyżej nigdy,
 * - miękki limit: po wylosowaniu waga przedmiotu × 0,6 (do poziomu drużyny) albo × 0,2
 *   (powyżej; wtedy maleje też szansa całego przedziału +1 / +2),
 * - wagi liczy wyłącznie funkcja (MG nie wpisuje własnych wag w tym trybie).
 * Bez znanego poziomu drużyny wszystkie pozycje mają równe szanse.
 *
 * W obu trybach: limit wylosowań pozycji (gdy lista ma „Limit wylosowań”) i przedmioty
 * gwarantowane (gdy lista je ma): każdy zawsze, w ilości losowanej z Min–Maks.
 */

/** Stałe trybu według poziomu — jedno miejsce do strojenia po testach w grze. */
export const LEVEL_DRAW = Object.freeze({
  belowFactor: 0.8,       // waga × 0,8 za każdy poziom poniżej drużyny
  aboveChance: [0.06, 0.015], // szansa na losowanie z +1 i +2
  softBelow: 0.6,         // miękki limit do poziomu drużyny
  softAbove: 0.2          // miękki limit powyżej poziomu drużyny
});

/** Liczba losowa z [0, 1): generator Foundry, gdy jest dostępny. */
function random() {
  return globalThis.CONFIG?.Dice?.randomUniform?.() ?? Math.random();
}

/** Indeks z listy wag (pomija zera) albo -1, gdy nie ma czego losować. */
function pickIndex(weights) {
  const total = weights.reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
  if (total <= 0) return -1;
  let roll = random() * total;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.findLastIndex((w) => w > 0);
}

/** Liczba całkowita z [min, max]. */
function between(min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Średni poziom drużyny (zaokrąglony): członkowie aktora drużyny PF2e, a gdy go nie ma —
 * postacie przypisane graczom. null, gdy nie ma żadnej postaci.
 */
export function partyLevel() {
  const party = globalThis.game?.actors?.party;
  let members = party?.members?.filter?.((a) => a?.type === "character") ?? [];
  if (!members.length) {
    const users = globalThis.game?.users?.filter?.((u) => !u.isGM && u.character) ?? [];
    members = users.map((u) => u.character).filter((a) => a?.type === "character");
  }
  const levels = members.map((a) => Number(a.level ?? a.system?.details?.level?.value)).filter(Number.isFinite);
  if (!levels.length) return null;
  return Math.round(levels.reduce((sum, l) => sum + l, 0) / levels.length);
}

/**
 * Waga bazowa pozycji w trybie według poziomu (przed miękkimi limitami): ≤ drużyny
 * 0,8 za każdy poziom niżej, +1 / +2 = 1 (wybór w obrębie przedziału), +3 i wyżej 0.
 */
export function levelWeight(entry, level) {
  const d = (Number(entry.level) || 0) - level;
  if (d > 2) return 0;
  if (d > 0) return 1;
  return LEVEL_DRAW.belowFactor ** -d;
}

/** Przedział pozycji względem drużyny: 0 = do poziomu drużyny, 1 = +1, 2 = +2, 3 = wyżej. */
function bandOf(entry, level) {
  return Math.min(3, Math.max(0, (Number(entry.level) || 0) - level));
}

/**
 * Szansa każdej pozycji na pojedyncze (pierwsze) losowanie w trybie według poziomu — ten sam
 * model co `drawFromList`, więc edytor listy i podgląd kategorii pokazują prawdziwe liczby.
 * @returns {number[]} prawdopodobieństwa (0–1) w kolejności `entries`; bez poziomu — równe
 */
export function levelChances(entries, level) {
  if (!entries.length) return [];
  if (!Number.isFinite(level)) return entries.map(() => 1 / entries.length);
  const w = entries.map((e) => levelWeight(e, level));
  const band = entries.map((e) => bandOf(e, level));
  const sumIn = (b) => w.reduce((sum, x, i) => sum + (band[i] === b ? x : 0), 0);
  const sums = [sumIn(0), sumIn(1), sumIn(2)];
  // Losowanie wybiera przedział: +2 z szansą 1,5%, +1 z 6%, reszta do poziomu drużyny;
  // pusty przedział oddaje swoją szansę przedziałowi do poziomu drużyny, a gdy i ten jest pusty — wszystkim.
  const p = [0, sums[1] > 0 ? LEVEL_DRAW.aboveChance[0] : 0, sums[2] > 0 ? LEVEL_DRAW.aboveChance[1] : 0];
  p[0] = 1 - p[1] - p[2];
  const total = sums[0] + sums[1] + sums[2];
  return entries.map((e, i) => {
    if (band[i] === 3 || w[i] <= 0) return 0;
    if (sums[0] <= 0) {
      // Nic do poziomu drużyny: przedział 0 przechodzi na wszystkie pozycje według wag.
      const fallback = total > 0 ? p[0] * (w[i] / total) : 0;
      return fallback + (band[i] ? p[band[i]] * (w[i] / sums[band[i]]) : 0);
    }
    return p[band[i]] * (w[i] / sums[band[i]]);
  });
}

/**
 * Losuje z listy `count` razy.
 * @param {object} list   dokument listy towaru (stock-lists-store.js)
 * @param {number} count  liczba losowań
 * @param {object} [options]
 * @param {number|null} [options.level]  poziom drużyny (tryb partyLevel); null = równe szanse
 * @returns {{ entry: object, quantity: number, guaranteed?: boolean }[]}  pozycje z liczbą sztuk
 */
export function drawFromList(list, count, { level = null } = {}) {
  // Pozycje oznaczone przy imporcie jako „nie znaleziono” nie biorą udziału w losowaniu.
  const entries = (list?.entries ?? []).filter((e) => !e.missing && (e.weight > 0 || list.mode === "partyLevel"));
  const counts = new Map();
  const levelMode = list?.mode === "partyLevel";
  const useLevel = levelMode && Number.isFinite(level);
  const limitOf = (e) => (list.drawLimit && e.limit ? e.limit : Infinity);

  if (entries.length && count > 0) {
    if (!useLevel) {
      // Ręczne wagi; w trybie według poziomu bez znanego poziomu drużyny — równe szanse.
      const weights = entries.map((e) => (levelMode ? 1 : Math.max(0, e.weight)));
      for (let n = 0; n < count; n++) {
        const i = pickIndex(weights);
        if (i < 0) break;
        const drawn = (counts.get(i) ?? 0) + 1;
        counts.set(i, drawn);
        if (drawn >= limitOf(entries[i])) weights[i] = 0;
      }
    } else {
      const weights = entries.map((e) => levelWeight(e, level));
      const band = (e) => Math.max(0, e.level - level); // 0 = do poziomu drużyny, 1 / 2 = powyżej
      const bandChance = [...LEVEL_DRAW.aboveChance];
      for (let n = 0; n < count; n++) {
        const inBand = (b) => entries.map((e, i) => (band(e) === b ? weights[i] : 0));
        const roll = random();
        let pick = 0;
        if (roll < bandChance[1]) pick = 2;
        else if (roll < bandChance[0] + bandChance[1]) pick = 1;
        let w = inBand(pick);
        if (!w.some((x) => x > 0)) w = inBand(0);
        if (!w.some((x) => x > 0)) w = weights.slice();
        const i = pickIndex(w);
        if (i < 0) break;
        const drawn = (counts.get(i) ?? 0) + 1;
        counts.set(i, drawn);
        const above = band(entries[i]);
        weights[i] *= above ? LEVEL_DRAW.softAbove : LEVEL_DRAW.softBelow;
        if (above) bandChance[above - 1] *= LEVEL_DRAW.softAbove;
        if (drawn >= limitOf(entries[i])) weights[i] = 0;
      }
    }
  }

  const result = [...counts].map(([i, quantity]) => ({ entry: entries[i], quantity }));
  if (list?.guaranteed) {
    for (const e of list.guaranteedEntries ?? []) result.push({ entry: e, quantity: between(e.min, Math.max(e.min, e.max)), guaranteed: true });
  }
  return result;
}
