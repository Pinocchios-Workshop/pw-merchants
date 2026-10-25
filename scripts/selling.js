/**
 * Sprzedawanie przedmiotów sklepowi przez propozycję (gracz → MG decyduje).
 *
 * Cena jest stała, bez targowania: sklep płaci połowę wartości przedmiotu,
 * a skarby (przedmioty typu „treasure”, np. klejnoty i dzieła sztuki) idą za
 * pełną wartość. MG decyduje tylko, które przedmioty sklepikarz przyjmie:
 * - wszystko zaznaczone → „Kup”: sprzedaż od razu;
 * - część odznaczona → „Kontroferta”: gracz sprzedaje resztę albo odrzuca;
 * - „Odrzuć całość”.
 *
 * Przebieg (socket modułu, wykonuje aktywny MG):
 *   gracz  → sell-offer     (propozycja)            → MG otwiera okno decyzji
 *   gracz  → sell-cancel    (wycofanie / zamknięcie okna)
 *   MG     → sell-counter   (kontroferta: przyjęte przedmioty i ilości) → gracz widzi ją w swoim oknie
 *   gracz  → sell-accept / sell-decline (odpowiedź na kontrofertę)
 *   MG     → sell-result    (sprzedane / odrzucone / błąd)
 * Przedmioty zostają u gracza do chwili sprzedaży.
 */
import { MODULE_ID, BUYBACK_CATEGORY } from "./constants.js";
import { newItemFlags } from "./shop-store.js";
import { isMerchantActor, purseCopper, setPurse, normalizePurse, formatCopper } from "./shop-data.js";

const SOCKET = `module.${MODULE_ID}`;

/* ---------------- Ceny ---------------- */

/** Czy przedmiot to skarb sprzedawany za pełną wartość (bez monet). */
export function isFullValue(item) {
  return item?.type === "treasure" && !item.isCurrency && !item.isCoinage;
}

/** Wartość `quantity` sztuk przedmiotu (cena z podręcznika) w miedziakach. */
export function itemValueCopper(item, quantity) {
  const price = item?.system?.price;
  const copper = Number(price?.value?.copperValue) || 0;
  const per = Math.max(1, price?.per ?? 1);
  return (copper * Math.max(0, quantity)) / per;
}

/** Ile sklep zapłaci za `quantity` sztuk: ½ wartości albo 100% przy skarbach, w dół do 1 cp. */
export function saleCopper(item, quantity) {
  const value = itemValueCopper(item, quantity);
  return Math.floor(isFullValue(item) ? value : value / 2);
}

/** Przedmioty postaci, które można sprzedać: fizyczne, bez monet. */
export function sellableItems(actor) {
  return (actor?.inventory?.contents ?? []).filter((i) => !i.isCurrency && !i.isCoinage);
}

/** Powód, dla którego przedmiotu nie można sprzedać, albo null. */
export function unsellableReason(item) {
  if (item?.isOfType?.("backpack") && item.contents?.size) return "PF2E_SHOP.Sell.ContainerNotEmpty";
  return null;
}

/* ---------------- Socket ---------------- */

const listeners = { player: new Map(), gm: new Map() };

/** Okno gracza nasłuchuje odpowiedzi na swoją propozycję. */
export function onPlayerMessage(offerId, callback) {
  if (callback) listeners.player.set(offerId, callback);
  else listeners.player.delete(offerId);
}

/** Okno MG nasłuchuje wycofania i odpowiedzi gracza. */
export function onGMMessage(offerId, callback) {
  if (callback) listeners.gm.set(offerId, callback);
  else listeners.gm.delete(offerId);
}

export function sendToGM(data) {
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("PF2E_SHOP.Sell.NoGM"));
    return false;
  }
  game.socket.emit(SOCKET, { ...data, userId: data.userId ?? game.user.id });
  return true;
}

export function sendToPlayer(userId, data) {
  game.socket.emit(SOCKET, { ...data, targetUserId: userId });
}

/** Wiadomości sprzedaży (wywoływane z nasłuchu socketu modułu). */
export async function handleSellMessage(data, openReview) {
  const isGMClient = !!game.users.activeGM?.isSelf;
  switch (data?.action) {
    case "sell-offer":
      if (isGMClient) await openReview(data);
      return true;
    case "sell-cancel":
    case "sell-accept":
    case "sell-decline":
      if (isGMClient) listeners.gm.get(data.offerId)?.(data);
      return true;
    case "sell-counter":
    case "sell-result":
      if (data.targetUserId === game.user.id) listeners.player.get(data.offerId)?.(data);
      return true;
    default:
      return false;
  }
}

/* ---------------- Wykonanie sprzedaży (klient MG) ---------------- */

/**
 * Sprzedaje wskazane przedmioty: zabiera je postaci, dokłada do sklepu (do „Odkupu”),
 * płaci z kasy sklepu i pisze na czacie.
 * @param {object} offer  { shopUuid, sellerUuid, items: [{ itemId, quantity }] }
 * @param {Array<{itemId: string, quantity: number}|string>} accepted  przyjęte przez MG przedmioty
 *        z ilością (MG może przyjąć mniej sztuk, niż zaproponowano); samo id = cała zaproponowana ilość
 * @returns {{ ok: boolean, message: string, data?: object, sold?: object[] }}
 */
export async function executeSale(offer, accepted) {
  try {
    const shop = await fromUuid(offer.shopUuid);
    const seller = await fromUuid(offer.sellerUuid);
    if (!isMerchantActor(shop) || !seller) return { ok: false, message: "PF2E_SHOP.Sell.Error.Missing" };

    // Sprawdzenie: przedmioty nadal są u postaci w tej ilości.
    const lines = [];
    const wanted = new Map(
      (accepted ?? []).map((a) => (typeof a === "string" ? [a, Infinity] : [a?.itemId, Number(a?.quantity) || 0]))
    );
    for (const line of offer.items) {
      if (!wanted.has(line.itemId)) continue;
      // Nie więcej, niż gracz zaproponował; 0 sztuk = przedmiot odrzucony.
      const quantity = Math.max(0, Math.min(line.quantity, Math.floor(wanted.get(line.itemId))));
      if (quantity < 1) continue;
      const item = seller.items.get(line.itemId);
      if (!item || (item.quantity ?? 0) < quantity || unsellableReason(item)) {
        return { ok: false, message: "PF2E_SHOP.Sell.Error.Changed", data: { item: item?.name ?? line.name ?? "?" } };
      }
      lines.push({ item, quantity, price: saleCopper(item, quantity) });
    }
    if (!lines.length) return { ok: false, message: "PF2E_SHOP.Sell.Error.Empty" };

    const total = lines.reduce((sum, l) => sum + l.price, 0);
    const purse = purseCopper(shop);
    if (purse < total) {
      return { ok: false, message: "PF2E_SHOP.Sell.Error.ShopFunds", data: { price: formatCopper(total) } };
    }

    // 1. Pieniądze: sklep płaci, postać dostaje kwotę rozłożoną na gp/sp/cp.
    if (total > 0) {
      await setPurse(shop, purse - total);
      const add = seller.inventory.addCurrency ?? seller.inventory.addCoins;
      await add.call(seller.inventory, normalizePurse(total));
    }

    // 2. Przedmioty: do sklepu (bez stanu założenia, bez pojemnika), u postaci mniej.
    const sources = [];
    const deletes = [];
    const updates = [];
    for (const { item, quantity } of lines) {
      const source = item.toObject();
      delete source._id;
      delete source.system.equipped;
      source.system.containerId = null;
      source.system.quantity = quantity;
      // Sprzedane przedmioty trafiają do „Odkupu” (75% ceny, bez mnożnika sklepu).
      source.flags = { ...(source.flags ?? {}), [MODULE_ID]: newItemFlags(null, BUYBACK_CATEGORY) };
      sources.push(source);
      const left = (item.quantity ?? 0) - quantity;
      if (left > 0) updates.push({ _id: item.id, "system.quantity": left });
      else deletes.push(item.id);
    }
    await shop.createEmbeddedDocuments("Item", sources);
    if (updates.length) await seller.updateEmbeddedDocuments("Item", updates);
    if (deletes.length) await seller.deleteEmbeddedDocuments("Item", deletes);

    // 3. Czat.
    const list = lines.map((l) => `${l.quantity}× ${l.item.name}`).join(", ");
    const content = game.i18n.format("PF2E_SHOP.Sell.Chat", {
      seller: seller.name, items: list, price: formatCopper(total), shop: shop.name
    });
    await ChatMessage.create({ content: `<p>${content}</p>`, speaker: ChatMessage.getSpeaker({ actor: seller }) });

    return {
      ok: true,
      message: "PF2E_SHOP.Sell.Done",
      data: { price: formatCopper(total) },
      sold: lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, price: l.price }))
    };
  } catch (error) {
    console.error(`${MODULE_ID} | Błąd sprzedaży`, error);
    return { ok: false, message: "PF2E_SHOP.Sell.Error.Unknown" };
  }
}
