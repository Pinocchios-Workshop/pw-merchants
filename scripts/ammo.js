/**
 * Amunicja specjalna bez wybranego typu (np. Beacon Shot: `system.craftableAs`, bez
 * `system.baseItem`).
 *
 * PF2e przy dodaniu takiej amunicji do aktora pyta o typ amunicji (okno wyboru w
 * `AmmoPF2e._preCreate`). W sklepie tego nie chcemy: przy uzupełnianiu towaru MG musiałby
 * wybierać typ dla każdej pozycji. Dlatego:
 * - w sklepie (Loot w trybie Merchant) amunicja trafia bez typu — okno PF2e jest pomijane
 *   (`patchAmmoPreCreate`); amunicja z typem ustawionym z góry zostaje z nim,
 * - typ wybiera gracz przy zakupie (okno zakupu, `ammoTypeChoices`), spośród typów,
 *   jako które ta amunicja może występować (pusta lista `craftableAs` = dowolny typ),
 * - zakup zapisuje wybrany typ w kopii przedmiotu u postaci (purchase.js), więc PF2e
 *   u postaci już o nic nie pyta.
 */
import { MODULE_ID } from "./constants.js";
import { isMerchantActor } from "./shop-data.js";

const PATCHED = Symbol.for(`${MODULE_ID}.ammoPatched`);

/** Czy przedmiot to amunicja specjalna bez wybranego typu (dane źródłowe). */
export function isUntypedAmmo(item) {
  if (item?.type !== "ammo") return false;
  const system = item._source?.system ?? item.system ?? {};
  return Array.isArray(system.craftableAs) && !system.baseItem;
}

/**
 * Typy amunicji do wyboru przy zakupie — jak w oknie PF2e: bez magazynków; typy z
 * `craftableAs` (z odmianami, np. „rounds” → naboje do konkretnej broni), a przy pustej
 * liście wszystkie. Jedna lista alfabetycznie (bez podziału na grupy); `own` = typ do broni
 * kupującego (okno zakupu zaznacza go domyślnie).
 * @param {Item} item
 * @param {Actor} [buyer]  postać, której broń wskazuje domyślny typ
 * @returns {{ value: string, label: string, own: boolean }[]}
 */
export function ammoTypeChoices(item, buyer = null) {
  if (!isUntypedAmmo(item)) return [];
  const craftableAs = (item._source?.system ?? item.system).craftableAs;
  const all = Object.entries(CONFIG.PF2E?.ammoTypes ?? {})
    .filter(([, data]) => !data.magazine)
    .map(([slug, data]) => ({ slug, ...data }));
  const compatible = craftableAs.length
    ? all.filter((t) => craftableAs.includes(t.slug) || craftableAs.includes(t.parent))
    : all;
  const supported = new Set((buyer?.itemTypes?.weapon ?? []).map((w) => w.system?.ammo?.baseType).filter(Boolean));
  return compatible
    .map((t) => ({ value: t.slug, label: game.i18n.localize(t.label), own: supported.has(t.slug) }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

/** Etykieta typu amunicji w języku gry („Arrows”) albo sama nazwa systemowa. */
export function ammoTypeLabel(slug) {
  const label = CONFIG.PF2E?.ammoTypes?.[slug]?.label;
  return label ? game.i18n.localize(label) : slug;
}

/**
 * Pomija okno wyboru typu amunicji PF2e, gdy amunicja specjalna bez typu powstaje w sklepie
 * (uzupełnianie towaru, upuszczenie na kartę sklepu). Poza sklepem PF2e działa jak zwykle.
 * @returns {boolean} czy podpięto (albo było już podpięte)
 */
export function patchAmmoPreCreate() {
  const AmmoClass = CONFIG.PF2E?.Item?.documentClasses?.ammo;
  const proto = AmmoClass?.prototype;
  if (!proto || !Object.prototype.hasOwnProperty.call(proto, "_preCreate")) return false;
  if (proto[PATCHED]) return true;
  const original = proto._preCreate;
  const parentPreCreate = Object.getPrototypeOf(proto)._preCreate;
  proto._preCreate = function (data, options, user) {
    if (isMerchantActor(this.parent) && isUntypedAmmo(this)) return parentPreCreate.call(this, data, options, user);
    return original.call(this, data, options, user);
  };
  proto[PATCHED] = true;
  return true;
}
