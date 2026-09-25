# ACO! — migracja online, 25 września 2026

Repozytorium: https://github.com/ACOfitness/demo
Panel: https://acofitness.github.io/demo/panel.html
Supabase: organizacja ACO!, projekt `kxbqigvxmrzxaszovdoo`, London.
Nie użyto kont Big Bear ani danych z ich projektów.

## Architektura

- Frontend jest statyczną aplikacją Pages, Supabase Auth weryfikuje logowanie.
- Funkcja Edge `aco-api` sprawdza użytkownika w Auth oraz aktualną sesję,
  stan konta i rolę w bazie przy każdym chronionym żądaniu.
- Wdrożony wcześniej znormalizowany schemat `aco_*` jest fundamentem RLS,
  ale nie stanowi aktywnego magazynu bieżącej aplikacji. Pozostaje pusty.
- Aktywnym magazynem są wiersze encji JSONB w `aco_private.runtime_entities`:
  osobne rekordy kont, klientów, trenerów, sesji, pakietów, notatek, wiadomości
  i pozostałych obiektów. Nie jest to przyjmowany od klienta zrzut całej bazy.
- Przeglądarka nie może czytać ani zapisywać tych tabel bezpośrednio. RLS,
  prywatny schemat i brak grantów ograniczają je do serwerowego API.
- API oblicza zmianę po walidacji dozwolonej komendy, zapisuje wyłącznie zmienione
  rekordy. Blokada rewizji zapewnia atomowość i serializację, a identyfikator
  żądania chroni przed powieleniem po ponowieniu. Konflikt powoduje przeliczenie
  na aktualnych danych. Dla planowanych 10 trenerów / 150 klientów jest to
  świadomie prosta architektura; przy większej skali wymaga podziału transakcji.
- Zdjęcia są ograniczonymi rozmiarem obrazami w rekordach, a nie publicznym
  bucketem. Interfejs kadruje je i zapisuje JPEG; API odrzuca SVG/HTML.
- Czas pochodzi z PostgreSQL, kalendarz biznesowy używa Europe/Warsaw.

## Migracje i wdrożenie

Wykonano przez SQL Editor:
1. `20260925094836_aco_access_foundation.sql`
2. `20260925125207_aco_command_transactions.sql`
3. `20260925133351_registration_identity_check.sql`

Przed pierwszym użyciem CLI `db push` należy uzgodnić historię migracji z
rzeczywistym schematem. Nie uruchamiać powtórnie skryptów tworzących tabele.
Funkcja Edge jest budowana z `server/` przez `tooling/build-edge.mjs`.
Weryfikację JWT w bramie starszego typu zastępuje obowiązkowa kontrola Auth
wewnątrz funkcji; nie oznacza to publicznego dostępu do operacji biznesowych.
Dozwolony origin: `https://acofitness.github.io`.

Pierwszy administrator `admin@acofitness.pl` został utworzony przez właściciela,
a uprawnienie nadane po jego jednoznacznym potwierdzeniu. Nie importowano
starej bazy localStorage ani lokalnych haseł. Ewentualny import rzeczywistych
danych wymaga osobnego, walidowanego procesu.

## Sprawdzenia

Lokalnie: 60 testów aplikacji i API, 23 testy PostgreSQL/integracyjne,
kontrola TypeScript obejmująca frontend i serwer, build produkcyjny.
Testy obejmują role, prywatne notatki i korespondencję, zastępstwa, podmianę
użytkownika, SQL injection jako parametr, podwójną rezerwację, ponawianie
zapisu, unieważnienie sesji oraz rejestrację i aktywację.
Zdalnie sprawdzono brak danych prywatnych w publicznym API, odmowę dostępu
bez logowania i odmowę bezpośredniego wywołania uprzywilejowanego RPC.
Właściciel zalogował się jako administrator. Zweryfikowano zapis ustawienia,
ponowny odczyt po odświeżeniu i przywrócenie pierwotnej wartości (15 minut).
Sprawdzono główne ekrany administratora. Testy nie zastępują zewnętrznego audytu.

GitHub Actions: https://github.com/ACOfitness/demo/actions/runs/36143284561
Wdrożenie zakończone sukcesem, commit `b3c4f199b2e70495ea90155d416343e5f5ff6d40`.
Wersja online została sprawdzona w przeglądarce; publiczny plik JavaScript
jest identyczny z lokalnie przetestowanym buildem (`index-CRA4FjJe.js`).
Funkcja Edge: SHA-256 `1a36f864226d70b80400095a9d4bd266a3e689dfdeb1a2e9fd98d16a8a3e209a`.
Audyt zależności produkcyjnych: brak znanych podatności w dniu wdrożenia.
Supabase Security Advisor: 0 błędów, 1 ostrzeżenie o wyłączonym sprawdzaniu
haseł z wycieków (funkcja wymaga planu Pro). 6 informacji o RLS bez polityk
dotyczy prywatnych tabel serwera i jest zamierzone. Auth wymaga minimum
12 znaków w nowych hasłach.

## Integracje i ograniczenia operacyjne

- SMTP nie jest jeszcze skonfigurowane: Supabase domyślnie wysyła tylko do
  członków zespołu projektu. Wysyłka linków do klientów wymaga własnego SMTP.
- Płatności są rozliczane ręcznie przez administratora; brak bramki online,
  webhooków płatniczych i integracji Fakturowni.
- Brak automatycznej migracji danych z przeglądarek i brak awaryjnego trybu offline.
- MFA administratora, automatyczne kopie poza projektem, monitoring alertów
  i test odtworzenia kopii wymagają konfiguracji przed rzeczywistą eksploatacją.
- Utworzenie Auth i zapis domenowy należą do różnych usług. Przy awarii między
  nimi może pozostać nieprzypisany użytkownik Auth bez dostępu do aplikacji;
  administrator projektu musi uzgodnić taki przypadek. Nie usuwać automatycznie
  konta po niepewnym wyniku sieciowym, bo zapis mógł się już powieść.
- Limity żądań i rozmiaru ograniczają nadużycia, ale nie gwarantują odporności
  na każdy atak. Przed przyjmowaniem danych rzeczywistych wymagany jest przegląd
  operacyjny, szczególnie poczty, kopii, MFA i procedur odzyskania dostępu.
