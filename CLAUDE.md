# Pinocchio's Merchants — zasady pracy

Moduł Foundry VTT v14 dla systemu Pathfinder 2e (karta sklepu dla aktorów Loot w trybie Merchant). Autor: Darek (Pinocchio's Workshop). Rozmowa z autorem po polsku.

## Repozytoria

- `pw-merchants` (to repo, publiczne): kod modułu, testy, wydania.
- `project-docs` (prywatne, ta sama organizacja): dokumenty wewnętrzne — plan i historia zmian (`modules/merchant/PLAN.md`), architektura (`modules/merchant/ARCHITECTURE.md`), audyt, opis wyszukiwarki (`modules/merchant/SEARCH.md`), zasady nazewnictwa i podziału pracy. Przed większą zmianą przeczytaj odpowiednie dokumenty stamtąd.

Nie wrzucaj do tego repo dokumentów wewnętrznych (planów, audytów, opisów luk bezpieczeństwa).

## Gałęzie i wydania

- Praca zawsze na gałęzi `dev` albo na gałęzi zadania odbitej od `dev`; zmiany wchodzą do `dev` przez pull request.
- `main` = stan ostatniego wydania. `dev` → `main` tylko na wyraźną prośbę autora, potem tag `vX.Y.Z` na `main` uruchamia wydanie (`.github/workflows/release.yml`).
- W repo jest wersja robocza: `module.json` i `scripts/constants.js` mają ID `pw-merchants-dev`. Nie zmieniaj go na `pw-merchants` — robi to tylko `tools/build-release.mjs` przy wydaniu.
- Do wersji 0.54 moduł miał ID `pw-merchant` / `pw-merchant-dev`. `moveLegacyData` (`shop-store.js`) kopiuje dane spod dawnego ID i dawne formaty plików list są nadal czytane — nie usuwaj tego bez decyzji autora.
- Rodzina modułów: `pw-merchants`, `pw-core`, `pw-search` (ID = nazwa folderu = nazwa repo).

## Po każdej zmianie

1. Testy: `node tests/run-tests.mjs` — wszystkie muszą przejść. Nowa funkcja = nowe testy (logika wyszukiwania, dane, migracje).
2. Podbij wersję w `module.json` (nowa funkcja: minor, poprawka: patch).
3. W `project-docs`: wpis w historii zmian w `modules/merchant/PLAN.md` (wersja + opis), aktualizacja sekcji Gotowe / Do zrobienia / Do ustalenia, wersja w nagłówku `modules/merchant/ARCHITECTURE.md` i opis zmian w architekturze, `SEARCH.md` przy zmianach wyszukiwarki.
4. Commit z jasnym opisem; pull request do `dev`.

## Zasady kodu

- **Jedna implementacja wspólnych funkcji:** używaj istniejących funkcji i wyglądu zamiast pisać nowe wersje tego samego.
- Dane modułu tylko przez `shop-store.js` i `stock-lists-store.js` (schemat, migracje, kopie zapasowe). Zmiana kształtu danych = migracja + plik testowy w `tests/fixtures/`.
- HTML w szablonach przez `{{ }}`; `{{{ }}}` tylko dla tekstów z plików tłumaczeń modułu, nigdy dla danych od użytkownika.
- Klucze wyszukiwania i ich skróty tylko w `SEARCH_KEY_DEFS` (`scripts/sheets/filters.js`).
- Treść Syntax Guide tylko po angielsku w `lang/en.json`; `lang/pl.json` ma tylko etykiety okien.
- Placeholder każdego pola wyszukiwania: „Type plain words to search by name. Add key:value filters to narrow the list.” (stała decyzja autora).
- Komentarze w kodzie po polsku, zwięźle.

## Sposób pracy

- Praca = kod i dokumentacja. Bez PDF z podglądem UI, chyba że autor poprosi; pojedyncze zrzuty PNG do weryfikacji są w porządku.
- Gdy polecenie jest niejednoznaczne albo wykryjesz kolizję (np. skrótów kluczy), zgłoś to przed implementacją.
- Kończąc zadanie: krótko, co się zmieniło, co sprawdzone, co wymaga decyzji autora.
