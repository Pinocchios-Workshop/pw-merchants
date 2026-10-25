/**
 * Punkt wejścia modułu.
 *
 * System PF2e rejestruje swoje karty w hooku "setup". Zaraz po nim bierzemy
 * jego klasę karty loota i podpinamy pod nią widok merchanta. Jeśli w "setup"
 * klasy jeszcze nie ma, próbujemy ponownie w "ready".
 */
import { MODULE_ID, TEMPLATES } from "./constants.js";
import { patchLootSheet } from "./sheets/merchant-sheet.js";
import { patchItemPrice, registerPriceCleanup, patchTransferToShop } from "./pricing.js";
import { patchAmmoPreCreate } from "./ammo.js";
import { registerPurchaseSocket } from "./purchase.js";
import { registerStockListsSetting, migrateStockLists, STOCK_LIST_SETTINGS } from "./stock-lists-store.js";
import { registerDataVersionSetting, migrateWorld, moveLegacyData, restoreShopBackup, DATA_VERSION_SETTING } from "./shop-store.js";
import { activateTooltips } from "./apps/tooltip.js";
import { handleSellMessage } from "./selling.js";
import { SellReview } from "./apps/sell-review.js";

/** Znajduje klasę karty loota zarejestrowaną przez PF2e. */
function findLootSheetClass() {
  const sheets = CONFIG.Actor.sheetClasses?.loot ?? {};
  const entry =
    sheets["pf2e.LootSheetPF2e"] ??
    Object.entries(sheets).find(([key]) => key.startsWith("pf2e."))?.[1];
  return entry?.cls ?? null;
}

let patched = false;
let pricePatched = false;
let transferPatched = false;
let ammoPatched = false;

function tryPatch(hookName) {
  if (game.system.id !== "pf2e") return;
  if (!transferPatched) transferPatched = patchTransferToShop();
  // Amunicja specjalna trafia do sklepu bez typu (bez okna wyboru PF2e); typ wybiera gracz przy zakupie.
  if (!ammoPatched) ammoPatched = patchAmmoPreCreate();
  if (!pricePatched) {
    pricePatched = patchItemPrice();
    if (pricePatched) console.log(`${MODULE_ID} | [${hookName}] Mnożnik cen podpięty pod przedmioty PF2e`);
  }
  if (patched) return;
  const LootSheet = findLootSheetClass();
  if (!LootSheet) {
    console.warn(`${MODULE_ID} | [${hookName}] Nie znaleziono karty loota PF2e. Zarejestrowane karty loot:`, Object.keys(CONFIG.Actor.sheetClasses?.loot ?? {}));
    return;
  }
  patched = patchLootSheet(LootSheet);
  if (patched) {
    console.log(`${MODULE_ID} | [${hookName}] Widok merchanta podpięty pod ${LootSheet.name}`);
    game.modules.get(MODULE_ID).api = { LootSheet, restoreShopBackup };
  }
}

/**
 * Wersja robocza (pw-merchants-dev) i wydanie (pw-merchants) to ten sam kod pod
 * innym ID. Włączone razem podpięłyby kartę dwa razy, więc działa tylko pierwszy
 * załadowany wariant, a drugi zgłasza to MG i nic nie robi.
 */
const LOADED = Symbol.for("pinocchio.merchant.loaded");
const otherVariant = globalThis[LOADED];
if (!otherVariant) globalThis[LOADED] = MODULE_ID;

const moduleTitle = () => game.modules.get(MODULE_ID)?.title ?? MODULE_ID;

if (otherVariant) {
  Hooks.once("ready", () => {
    if (!game.user.isGM) return;
    const other = game.modules.get(otherVariant)?.title ?? otherVariant;
    ui.notifications.warn(game.i18n.format("PF2E_SHOP.Error.OtherVariant", { module: moduleTitle(), other }));
  });
} else {
  // Wspólne części szablonów (np. pasek filtrów) rejestrowane jako partiale Handlebars.
  Hooks.once("init", () => {
    const load = foundry.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
    load?.({ psmFilters: TEMPLATES.filtersPartial });
    registerStockListsSetting();
    registerDataVersionSetting();
  });
  // Podpowiedzi modułu: osobny czas dla każdego elementu, przy kursorze (apps/tooltip.js).
  Hooks.once("ready", activateTooltips);
  registerPriceCleanup();
  Hooks.once("setup", () => tryPatch("setup"));
  Hooks.once("ready", onReady);
}

function onReady() {
  if (game.system.id !== "pf2e") {
    ui.notifications.error(game.i18n.format("PF2E_SHOP.Error.WrongSystem", { module: moduleTitle() }));
    return;
  }
  tryPatch("ready");
  // Dane z poprzednich wersji modułu → aktualny format (z kopią; tylko MG, raz na wersję danych).
  // Najpierw kopia danych spod dawnego ID modułu (do 0.54: pw-merchant), potem migracja schematów.
  moveLegacyData([DATA_VERSION_SETTING, ...STOCK_LIST_SETTINGS])
    .catch((error) => console.error(`${MODULE_ID} | Kopiowanie danych spod dawnego ID nie powiodło się`, error))
    .then(() => migrateWorld(migrateStockLists))
    .catch((error) => console.error(`${MODULE_ID} | Migracja danych nie powiodła się`, error));
  registerPurchaseSocket();
  game.socket.on(`module.${MODULE_ID}`, (data) => handleSellMessage(data, (offer) => SellReview.openFromOffer(offer)));
  if (!patched) ui.notifications.error(game.i18n.format("PF2E_SHOP.Error.PatchFailed", { module: moduleTitle() }));
  if (!pricePatched) ui.notifications.error(game.i18n.format("PF2E_SHOP.Error.PricePatchFailed", { module: moduleTitle() }));
}
