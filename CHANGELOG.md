# Changelog

## Unreleased (development 0.26 – 0.54)

Highlights since the first release; the detailed development history is kept internally.

- **Stock lists:** lists saved in the world with weighted entries, guaranteed items and draw limits; a party-level mode that computes chances from the level of the party; export and import as JSON files; categories draw from stock lists.
- **Spells as scrolls and wands:** a spell list in the stock list browser; scrolls and wands of a chosen rank, including heightened spells; spell descriptions in the PF2e style.
- **Search:** `tag:` replaced by `trait:`; new keys for rarity, item types, weapons, armor, shields, consumables, ammunition and spell traditions, each with a short form; logical operators AND, OR and NOT; filters shown as PF2e-style labels in the search field.
- **Syntax Guide:** a help window next to every search field with descriptions, examples and every valid value of each key.
- **Data safety:** all module data has a schema version, migrations and automatic backups.
- **Windows:** sizes for 1920 × 1080 and 2560 × 1440 screens; many layout and accessibility fixes.

## 0.1.0 — Pinocchio's Merchants

First release, built from development version 0.25.1.

- Merchant sheet for PF2e Loot actors in Merchant mode (GM and player views).
- Categories, several roll tables per category with "from–to" ranges, random stock (replace / add).
- Filters: name and `tag:` search (PF2e traits and rarity), level and price ranges, sorting, category toggles on one line with "+N".
- Price modifier, custom base prices, shop purse, shop tags and description.
- Buying for players (automatic, run on the active GM's client).
- Selling to the shop with GM decisions: buy, counteroffer (including fewer pieces), reject; Buyback category.
