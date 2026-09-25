# ACO! — panel treningów personalnych

Panel: https://acofitness.github.io/demo/panel.html

Aplikacja korzysta z Supabase Auth oraz serwerowego API `aco-api`. Dane biznesowe
są zapisywane w PostgreSQL; przeglądarka nie jest bazą i nie ma trybu awaryjnego
z zapisem lokalnym. Sesja Auth jest przechowywana w sessionStorage.

## Praca z kodem

- `pnpm install --frozen-lockfile`
- `pnpm test` — reguły biznesowe, filtrowanie danych, autoryzacja HTTP
- `pnpm --dir tooling/migration install --frozen-lockfile`
- `pnpm run test:database` — RLS, transakcje, konflikty rezerwacji, aktywacja
- `pnpm build` — kontrola TypeScript i statyczna strona
- `pnpm run build:server` — samodzielny plik funkcji Edge

GitHub Actions publikuje Pages po ręcznym uruchomieniu workflow. Kod publiczny
zawiera wyłącznie publiczny adres projektu i publishable key. Klucz serwerowy
pochodzi z wbudowanej zmiennej środowiskowej funkcji Supabase.

## Konta i uprawnienia

Pierwszy administrator: `admin@acofitness.pl`; hasło ustawił właściciel projektu
bezpośrednio w Supabase. Nie ma domyślnego hasła ani lokalnego administratora.
Administrator tworzy trenerów z hasłem tymczasowym; pierwsze logowanie wymaga
zmiany. Reset unieważnia istniejące sesje. Usunięcie trenera odbiera dostęp,
zachowując historię; klient musi mieć prowadzącego.

Rejestracja rezerwuje konsultację. Trener może zatwierdzić klienta od 30 minut
po jej początku, wybierając produkt i intensywność. Aktywacja wymaga linku
wysłanego na adres klienta. E-mail i data urodzenia nie wystarczają do przejęcia
konta. Do wysyłki do rzeczywistych klientów potrzebny jest własny SMTP.

Role, dostęp zastępcy, ceny, limity treningów i czas są sprawdzane na serwerze.
Klient nie otrzymuje prywatnych notatek ani stawek trenerów. Administrator nie
otrzymuje cudzej prywatnej korespondencji. Zegar testowy nie działa online.

## Rozliczenia

Bramka płatnicza nie jest podłączona. Klient przekazuje rezerwację do rozliczenia,
a administrator potwierdza rzeczywiście otrzymaną wpłatę. Przeglądarka klienta
nie może zadeklarować opłaconego pakietu. Rezerwacje zachowują ustawiony limit
czasu; nieopłacone wygasają. Konsultacje rozlicza administrator w Sprzedaży.

Ceny pakietów, promocje, opisy kart, dostępność, ważność, godziny dodatkowe,
wiadomości i notatki korzystają z tego samego API. Zachowano interfejs ACO!,
kadrowanie zdjęć, kalendarz oraz pionowy dziennik.

Szczegóły wdrożenia i ograniczenia: [stan migracji](docs/MIGRATION-STATUS.md).
Zasady bezpieczeństwa: [granice bezpieczeństwa](docs/SECURITY-BOUNDARIES.md).
