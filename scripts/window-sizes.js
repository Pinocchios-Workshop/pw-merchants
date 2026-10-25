/**
 * Rozmiary okien modułu dla dwóch klas ekranów — JEDYNE miejsce, w którym ustalamy
 * stałe rozmiary dużych okien (zasada „Skalowanie okien” w PLAN.md).
 *
 * Presety:
 * - `fhd`  — ekran 1920 × 1080 (i mniejsze, po dopasowaniu do ekranu),
 * - `qhd`  — ekran 2560 × 1440 i większe (także 34" 3440 × 1440).
 *
 * Preset wybieramy z wymiarów obszaru przeglądarki (`innerWidth` / `innerHeight`, czyli już
 * po skalowaniu systemu). Każdy rozmiar jest dodatkowo przycinany do ekranu z marginesem,
 * więc okno nigdy nie wychodzi poza ekran (np. przeglądarka z paskami na Full HD).
 * Okna dopasowujące wysokość do treści mają `height: "auto"`.
 */

/** Margines od krawędzi ekranu (px). */
const MARGIN = 48;

/** Od jakiego obszaru przeglądarki używamy presetu 2560 × 1440. */
const QHD_MIN = { width: 2400, height: 1250 };

export const SCREEN_PRESETS = Object.freeze({
  fhd: Object.freeze({
    label: "1920 × 1080",
    merchantSheet: { width: 980, height: 900 },
    sellDialog: { width: 940, height: 720 },
    sellReview: { width: 1000, height: 560 },
    stockLibrary: { width: 820, height: "auto" },
    stockLibraryRows: 6,
    stockEditor: { width: 1720, height: 1030 },
    syntaxGuide: { width: 1040, height: 900 }
  }),
  qhd: Object.freeze({
    label: "2560 × 1440",
    merchantSheet: { width: 1120, height: 1200 },
    sellDialog: { width: 1120, height: 900 },
    sellReview: { width: 1200, height: 720 },
    stockLibrary: { width: 960, height: "auto" },
    stockLibraryRows: 10,
    stockEditor: { width: 2160, height: 1340 },
    syntaxGuide: { width: 1200, height: 1200 }
  })
});

/**
 * Klucz presetu dla bieżącego ekranu: "qhd" albo "fhd".
 * `globalThis.__psmScreenPreset` wymusza preset (tylko design i testy).
 */
export function screenPreset() {
  if (SCREEN_PRESETS[globalThis.__psmScreenPreset]) return globalThis.__psmScreenPreset;
  const width = globalThis.innerWidth || 1920;
  const height = globalThis.innerHeight || 1080;
  return width >= QHD_MIN.width && height >= QHD_MIN.height ? "qhd" : "fhd";
}

/**
 * Rozmiar okna `name` z presetu bieżącego ekranu, przycięty do ekranu.
 * @param {keyof typeof SCREEN_PRESETS.fhd} name
 * @param {object} [options]
 * @param {boolean} [options.center]  dodaj `left` / `top`, żeby okno stało na środku ekranu
 * @returns {{ width: number, height: number|"auto", left?: number, top?: number }}
 */
export function windowSize(name, { center = false } = {}) {
  const preset = SCREEN_PRESETS[screenPreset()][name] ?? SCREEN_PRESETS.fhd[name];
  const screenW = globalThis.innerWidth || preset.width + MARGIN;
  const screenH = globalThis.innerHeight || (typeof preset.height === "number" ? preset.height : 900) + MARGIN;
  const width = Math.min(preset.width, Math.max(320, screenW - MARGIN));
  const height = typeof preset.height === "number" ? Math.min(preset.height, Math.max(320, screenH - MARGIN)) : preset.height;
  const size = { width, height };
  if (center) {
    size.left = Math.max(0, Math.round((screenW - width) / 2));
    if (typeof height === "number") size.top = Math.max(0, Math.round((screenH - height) / 2));
  }
  return size;
}

/** Ile list towaru biblioteka pokazuje bez przewijania (Full HD 6, 2560 × 1440: 10). */
export function libraryRows() {
  return SCREEN_PRESETS[screenPreset()].stockLibraryRows;
}

/**
 * Ustawia okno na środku ekranu według jego rzeczywistego rozmiaru (także przy wysokości
 * „auto”). Wywoływane po zmianie stanu okna, które zmienia jego rozmiar (np. powrót
 * z edytora list do biblioteki), żeby okno nie zostawało w rogu ekranu.
 * @param {Application|ApplicationV2} app
 */
export function centerApp(app) {
  const el = app?.element?.[0] ?? app?.element;
  const frame = el?.closest?.(".application, .app") ?? el;
  const rect = frame?.getBoundingClientRect?.();
  if (!rect?.width) return;
  const left = Math.max(0, Math.round(((globalThis.innerWidth || rect.width) - rect.width) / 2));
  const top = Math.max(0, Math.round(((globalThis.innerHeight || rect.height) - rect.height) / 2));
  app.setPosition({ left, top });
}
