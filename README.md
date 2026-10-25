# Pinocchio's Merchants

A merchant sheet for **Pathfinder 2e** in **Foundry VTT**. It replaces the look of the Loot actor in **Merchant** mode with a shop styled like the PF2e character sheet, and adds what a GM needs to run shops at the table.

*By Pinocchio's Workshop.*

> **Early development.** The module is in active development before its first public beta. Features, look and data format can still change.

## Features

**Shop**
- Categories with drag-and-drop ordering; items dropped on a category land in it, identical items stack.
- Price modifier (0–200%) for the whole shop, custom base price per item, prices rounded up.
- Shop purse (gp / sp / cp), editable name, cosmetic shop tags and a description for players.
- Buyback category for items sold by players (75% price).

**Stock lists and random stock**
- Stock lists saved in the world: weighted entries, guaranteed items, draw limits, or chances based on the party level.
- Spells added to lists as scrolls or wands of a chosen rank, including heightened spells.
- "Replenish stock" per category: replace or add to the current stock from the category's lists.
- Export and import of stock lists as JSON files.

**Search**
- One search field for names and `key:value` filters, with PF2e-style labels for every filter.
- Keys for traits, rarity, item types, weapon category / group / base / range, armor category / group / base / AC bonus, shield AC bonus / base, consumable category, ammunition type and spell tradition — each with a short form (`t:`, `r:`, `wg:`, `ac:` …).
- Logical operators: AND (space), OR (`weapon-group:axe|sword`) and NOT (`!rarity:rare`).
- A built-in **Syntax Guide** with examples and every valid value of each key.

**Players**
- The same filters and search as the GM, level and price ranges, sorting, category toggles.
- Expandable item descriptions with the shop price, ammunition type and rune usage.
- Buying for their characters, paid automatically (the GM only needs to be logged in).
- Selling items to the shop through an offer; the GM can buy, counteroffer (including fewer pieces) or reject.

## Requirements

- Foundry VTT v14
- Pathfinder 2e system

## Installation

In Foundry: **Add-on Modules → Install Module**, paste the manifest URL and install:

```
https://github.com/Pinocchios-Workshop/pw-merchants/releases/latest/download/module.json
```

Enable **Pinocchio's Merchants** in the world and set a Loot actor to **Merchant** mode to open the shop.

Do not enable it together with the development build (`pw-merchants-dev`); if both are on, only the first one loaded works and the GM sees a warning.

## Development

The repository holds the development build (`pw-merchants-dev`), which can be installed next to the release build.

- `dev` — ongoing work; changes arrive through pull requests.
- `main` — the state of the latest release.
- Releases are built from version tags (`v0.55.0`) on `main` by `tools/build-release.mjs`, which switches the module ID to `pw-merchants`.

Run the tests with Node 18+:

```
node tests/run-tests.mjs
```

## Reporting issues

Use the issue templates in this repository: **Bug report** or **Feature request**.

## Disclaimer

This is an unofficial, fan-made module. It is not published, endorsed or approved by Paizo Inc. or by the developers of the Pathfinder 2e system for Foundry VTT. It contains no Paizo content; it uses the PF2e system installed in your Foundry.
