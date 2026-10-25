/**
 * Mnożnik cen sklepu i własne ceny bazowe przedmiotów w mechanice PF2e.
 *
 * PF2e przy zakupie z merchanta (przeciągnięcie przedmiotu na kartę postaci)
 * liczy koszt z `item.price`, a okno wyboru ilości pokazuje cenę z tego samego
 * pola. Podmieniamy więc getter `price` przedmiotów fizycznych: przedmiot,
 * który leży w sklepie (Loot w trybie Merchant), zwraca cenę bazową (własną cenę
 * MG albo cenę z podręcznika) po mnożniku sklepu, zaokrągloną w górę do pełnej
 * liczby najmniejszego nominału ceny.
 *
 * Dane przedmiotu się nie zmieniają (`system.price` i `_source` zostają bez zmian),
 * więc przedmiot kupiony przez gracza ma w ekwipunku normalną cenę z podręcznika,
 * a zmiana mnożnika od razu zmienia ceny wszystkich przedmiotów w sklepie.
 *
 * W czasie przygotowania danych przedmiotu PF2e sam czyta `item.price`
 * (przeliczenie ceny z run i materiału) i zapisuje wynik do `system.price`.
 * Wtedy getter musi zwracać cenę bez mnożnika, inaczej mnożnik nakładałby się
 * przy każdym przeliczeniu, dlatego oznaczamy przedmiot na czas `prepareData`.
 */
import { MODULE_ID, ITEM_PRICE_FLAG } from "./constants.js";
import { isMerchantActor, modifiedPackCopper, getCustomPrice, coinsIn, unitDenomination, itemModifier } from "./shop-data.js";

const PATCHED = Symbol.for(`${MODULE_ID}.pricePatched`);
const PREPARING = Symbol.for(`${MODULE_ID}.preparing`);
const TRANSFER_PATCHED = Symbol.for(`${MODULE_ID}.transferPatched`);

/** Prototyp klasy PhysicalItemPF2e (ten, który definiuje getter `price`). */
function findPhysicalPrototype() {
  const classes = CONFIG.PF2E?.Item?.documentClasses ?? {};
  const start = classes.equipment ?? classes.weapon ?? classes.treasure;
  for (let proto = start?.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "price");
    if (descriptor?.get) return { proto, descriptor };
  }
  return null;
}

/** Cena w sklepie (własna cena bazowa i mnożnik) albo null, gdy przedmiotu to nie dotyczy. */
export function shopPriceFor(item, price) {
  if (!price?.value || item?.[PREPARING]) return null;
  // Monety to kasa sklepu, nie towar: ich wartość PF2e liczy z `price`,
  // więc mnożnik nie może ich dotyczyć (inaczej zmieniałby stan kasy).
  if (item.isCurrency || item.isCoinage || (item.type === "treasure" && item.system?.stackGroup === "coins")) return null;
  const actor = item.actor;
  if (!isMerchantActor(actor)) return null;
  const priceModifier = itemModifier(actor, item);
  const custom = getCustomPrice(item);
  if (priceModifier === 1 && !custom) return null;
  const base = custom ? { ...price, value: custom } : price;
  const Coins = price.value.constructor;
  const copper = modifiedPackCopper(base, priceModifier);
  // Własna cena zostaje w swojej walucie (bez zamiany na wyższe monety).
  if (custom) return { ...price, value: new Coins(coinsIn(copper, unitDenomination(custom))) };
  const coins = new Coins({ cp: copper });
  return { ...price, value: typeof coins.normalized === "function" ? coins.normalized() : coins };
}

/**
 * Własna cena dotyczy tylko sklepu: przedmiot kupiony przez gracza (albo
 * przeniesiony do innego aktora niż sklep) traci ją i ma cenę z podręcznika.
 */
export function registerPriceCleanup() {
  Hooks.on("preCreateItem", (item) => {
    if (isMerchantActor(item.parent)) return;
    if (!item._source?.flags?.[MODULE_ID]?.[ITEM_PRICE_FLAG]) return;
    item.updateSource({ [`flags.${MODULE_ID}.${ITEM_PRICE_FLAG}`]: null });
  });
}

/**
 * Gracz nie może przekazać przedmiotu sklepowi żadną drogą (także upuszczając
 * go na token sklepu na mapie): PF2e przenosi przedmioty między aktorami przez
 * `transferItemToActor`, więc blokujemy ją, gdy celem jest sklep, a działa gracz.
 */
export function patchTransferToShop() {
  const classes = CONFIG.PF2E?.Actor?.documentClasses ?? {};
  const start = classes.character ?? classes.loot;
  let proto = start?.prototype;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "transferItemToActor")) proto = Object.getPrototypeOf(proto);
  if (!proto) return false;
  if (proto[TRANSFER_PATCHED]) return true;
  const original = proto.transferItemToActor;
  proto.transferItemToActor = async function (targetActor, ...args) {
    if (!game.user.isGM && isMerchantActor(targetActor) && targetActor !== this) {
      ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Inventory.NoPlayerDrop"));
      return null;
    }
    return original.call(this, targetActor, ...args);
  };
  proto[TRANSFER_PATCHED] = true;
  return true;
}

/**
 * Podmienia getter `price` przedmiotów fizycznych. Zwraca true, gdy się udało
 * (albo było już zrobione).
 */
export function patchItemPrice() {
  const found = findPhysicalPrototype();
  if (!found) return false;
  const { proto, descriptor } = found;
  if (proto[PATCHED]) return true;

  Object.defineProperty(proto, "price", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      const price = descriptor.get.call(this);
      return shopPriceFor(this, price) ?? price;
    }
  });

  // Na czas przygotowania danych getter zwraca cenę bez mnożnika.
  const originalPrepare = proto.prepareData;
  proto.prepareData = function (...args) {
    this[PREPARING] = true;
    try {
      return originalPrepare.apply(this, args);
    } finally {
      this[PREPARING] = false;
    }
  };

  proto[PATCHED] = true;
  return true;
}
