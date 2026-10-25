/**
 * Okno edycji opisu sklepu (ApplicationV2, tylko MG).
 *
 * Opis to pole PF2e `system.details.description` aktora Loot; gracz widzi go na
 * karcie sklepu w miejscu panelu MG. Edytor to wbudowany w Foundry ProseMirror
 * (to samo co w opisach przedmiotów i dzienników); gdyby go zabrakło, okno
 * pokazuje zwykłe pole tekstowe z HTML.
 */
import { TEMPLATES } from "../constants.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const FIELD = "system.details.description";

export class DescriptionConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static open({ actor }) {
    if (!game.user.isGM) return null;
    const id = `pf2e-shop-description-${actor.id}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront();
    const app = new this({ id, actor });
    app.render({ force: true });
    return app;
  }

  constructor({ actor, ...options } = {}) {
    super(options);
    this.actor = actor;
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["pf2e-shop", "themed", "theme-light", "psm-category-window", "psm-description-window"],
    window: { icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 640, height: "auto" },
    form: { handler: DescriptionConfig.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: { cancel: DescriptionConfig.#onCancel }
  };

  static PARTS = {
    form: { template: TEMPLATES.descriptionConfig }
  };

  get title() {
    return game.i18n.format("PF2E_SHOP.DescriptionConfig.Title", { name: this.actor.name });
  }

  get description() {
    return foundry.utils.getProperty(this.actor, FIELD) ?? "";
  }

  async _prepareContext() {
    return { description: this.description };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const slot = this.element.querySelector("[data-editor-slot]");
    if (!slot) return;
    const ProseMirrorElement = foundry.applications.elements?.HTMLProseMirrorElement;
    if (!ProseMirrorElement?.create) {
      slot.querySelector("textarea")?.removeAttribute("hidden");
      return;
    }
    // Edytor od razu w trybie edycji (bez przycisku „edytuj”), z zapisem przez formularz okna.
    const editor = ProseMirrorElement.create({
      name: "description",
      value: this.description,
      toggled: false,
      height: 320
    });
    editor.classList.add("psm-description-editor");
    slot.replaceChildren(editor);
  }

  static async #onSubmit(event, form, formData) {
    const value = formData.object.description;
    if (typeof value === "string" && value !== this.description) {
      await this.actor.update({ [FIELD]: value });
    }
    await this.close();
  }

  static #onCancel() {
    this.close();
  }
}
