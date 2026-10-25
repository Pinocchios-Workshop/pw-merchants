/**
 * Kupowanie w sklepie przez gracza, automatycznie, bez udziału MG.
 *
 * Gracz nie może zmieniać sklepu (nie jest jego właścicielem), więc wysyła
 * prośbę o zakup przez socket modułu. Wykonuje ją klient aktywnego MG (musi być
 * zalogowany, ale nic nie klika): sprawdza towar i pieniądze, pobiera kwotę
 * od postaci, dodaje ją do kasy sklepu, przenosi przedmiot i pisze na czacie.
 *
 * Pieniądze liczymy w miedziakach:
 * - cena = cena paczki w sklepie (własna cena i mnożnik) × ilość / `per`, w górę;
 * - postać płaci funkcją PF2e `removeCurrency` „po wartości”: PF2e sam rozmienia
 *   monety (np. płacąc 6 cp złotem, oddaje resztę w sp/cp), reszta monet postaci
 *   zostaje taka, jaka była;
 * - kasa sklepu jest po każdej transakcji rozkładana na gp/sp/cp (bez platyny).
 */
import { MODULE_ID } from "./constants.js";
import { isUntypedAmmo, ammoTypeChoices, ammoTypeLabel } from "./ammo.js";
import {
  isMerchantActor, itemModifier, basePrice, modifiedPackCopper, purseCopper, setPurse, formatCopper
} from "./shop-data.js";

const SOCKET = `module.${MODULE_ID}`;

/** Kwota za `quantity` sztuk przedmiotu ze sklepu, w miedziakach. */
export function purchaseCost(shop, item, quantity) {
  const price = basePrice(item);
  const per = Math.max(1, price?.per ?? 1);
  const pack = modifiedPackCopper(price, itemModifier(shop, item));
  return Math.ceil((pack * Math.max(0, quantity)) / per);
}

/** Pieniądze postaci w miedziakach. */
export function fundsCopper(actor) {
  const coins = actor?.inventory?.currency ?? actor?.inventory?.coins;
  return Number(coins?.copperValue) || 0;
}

/** Postacie, którymi gracz może kupować (właściciel; najpierw przypisana postać). */
export function buyerCandidates(user = game.user) {
  const own = game.actors.filter((a) => a.type === "character" && a.testUserPermission(user, "OWNER"));
  const main = user.character;
  return main && own.includes(main) ? [main, ...own.filter((a) => a !== main)] : own;
}

/** Klient, który wykonuje zakupy: aktywny MG. */
function isResponsibleGM() {
  const gm = game.users.activeGM;
  return !!gm && gm.isSelf;
}

/**
 * Wysyła prośbę o zakup. MG wykonuje ją od razu u siebie, gracz przez socket.
 * @returns {Promise<boolean>} czy prośba poszła (wynik przychodzi osobno)
 */
export async function requestPurchase({ shop, item, buyer, quantity, ammoType = null }) {
  const data = {
    action: "buy",
    requestId: foundry.utils.randomID(),
    userId: game.user.id,
    shopUuid: shop.uuid,
    itemId: item.id,
    buyerUuid: buyer.uuid,
    quantity,
    // Amunicja specjalna bez typu: typ wybrany w oknie zakupu.
    ammoType
  };
  if (game.user.isGM) {
    await executePurchase(data);
    return true;
  }
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Purchase.NoGM"));
    return false;
  }
  game.socket.emit(SOCKET, data);
  return true;
}

/** Nasłuch socketu: MG wykonuje zakupy, gracz dostaje wynik. */
export function registerPurchaseSocket() {
  game.socket.on(SOCKET, async (data) => {
    if (data?.action === "buy" && isResponsibleGM()) {
      await executePurchase(data);
    } else if (data?.action === "buy-result" && data.userId === game.user.id) {
      showResult(data);
    }
  });
}

function showResult({ ok, message, data }) {
  const text = game.i18n.format(message, data ?? {});
  if (ok) ui.notifications.info(text);
  else ui.notifications.warn(text);
}

/** Wysyła wynik do gracza (albo pokazuje go, gdy kupował sam MG). */
function reply(request, ok, message, data = {}) {
  const result = { action: "buy-result", userId: request.userId, requestId: request.requestId, ok, message, data };
  if (request.userId === game.user.id) showResult(result);
  else game.socket.emit(SOCKET, result);
  return ok;
}

/** Wykonanie zakupu (klient MG). */
async function executePurchase(request) {
  try {
    const shop = await fromUuid(request.shopUuid);
    const buyer = await fromUuid(request.buyerUuid);
    const user = game.users.get(request.userId);
    const item = shop?.items?.get(request.itemId);
    const quantity = Math.floor(Number(request.quantity) || 0);

    // Sprawdzenia: sklep, przedmiot, kupujący, ilość, pieniądze.
    if (!isMerchantActor(shop) || !item) return reply(request, false, "PF2E_SHOP.Purchase.Error.Missing");
    if (!buyer || !user || !buyer.testUserPermission(user, "OWNER")) {
      return reply(request, false, "PF2E_SHOP.Purchase.Error.Buyer");
    }
    if (quantity < 1) return reply(request, false, "PF2E_SHOP.Purchase.Error.Quantity");
    const stock = item.quantity ?? 0;
    if (stock < 1) return reply(request, false, "PF2E_SHOP.Purchase.Error.SoldOut", { item: item.name });
    if (quantity > stock) {
      return reply(request, false, "PF2E_SHOP.Purchase.Error.Stock", { item: item.name, stock });
    }
    const cost = purchaseCost(shop, item, quantity);
    if (fundsCopper(buyer) < cost) {
      return reply(request, false, "PF2E_SHOP.Purchase.Error.Funds", {
        buyer: buyer.name, price: formatCopper(cost)
      });
    }

    // 1. Pieniądze: postać płaci (PF2e rozmienia monety), sklep dostaje kwotę.
    if (cost > 0) {
      const paid = await buyer.inventory.removeCurrency({ cp: cost }, { byValue: true });
      if (!paid) {
        return reply(request, false, "PF2E_SHOP.Purchase.Error.Funds", { buyer: buyer.name, price: formatCopper(cost) });
      }
      await setPurse(shop, purseCopper(shop) + cost);
    }

    // 2. Przedmiot: kopia do postaci (łączy się z takim samym), w sklepie mniej sztuk.
    // Ilość 0 zostawia przedmiot w sklepie jako „Wyprzedane”.
    const source = item.toObject();
    // Amunicja specjalna bez typu dostaje typ wybrany przez gracza (dozwolony dla tej amunicji;
    // inaczej pierwszy dozwolony) — PF2e u postaci już o niego nie pyta.
    let itemName = item.name;
    if (isUntypedAmmo(item)) {
      const allowed = ammoTypeChoices(item, buyer).map((c) => c.value);
      const ammoType = allowed.includes(request.ammoType) ? request.ammoType : allowed[0];
      if (ammoType) {
        source.system.baseItem = ammoType;
        itemName = `${item.name} (${ammoTypeLabel(ammoType)})`;
      }
    }
    delete source._id;
    delete source.flags?.[MODULE_ID];
    delete source.system.equipped;
    source.system.quantity = quantity;
    source.system.containerId = null;
    await buyer.inventory.add(source, { stack: true });
    await item.update({ "system.quantity": stock - quantity });

    // 3. Wpis na czacie.
    const content = game.i18n.format("PF2E_SHOP.Purchase.Chat", {
      buyer: buyer.name, quantity, item: itemName, price: formatCopper(cost), shop: shop.name
    });
    await ChatMessage.create({ content: `<p>${content}</p>`, speaker: ChatMessage.getSpeaker({ actor: buyer }) });

    return reply(request, true, "PF2E_SHOP.Purchase.Done", { quantity, item: itemName, price: formatCopper(cost) });
  } catch (error) {
    console.error(`${MODULE_ID} | Błąd zakupu`, error);
    return reply(request, false, "PF2E_SHOP.Purchase.Error.Unknown");
  }
}
