# ACO! - architektura i aktualizacja po audycie, 7 października 2026

Repozytorium: https://github.com/ACOfitness/demo
Panel: https://acofitness.github.io/demo/panel.html
Projekt Supabase ACO!: `kxbqigvxmrzxaszovdoo`. Konta Big Bear nie są używane.

## Aktualna architektura

Aktywną bazą są znormalizowane tabele `public.aco_*`: profile, konta, trenerzy,
klienci, pakiety, sesje, rezerwacje, notatki, wiadomości, rozliczenia i ustawienia.
Stary magazyn `aco_private.runtime_entities` nie jest bieżącym magazynem aplikacji.
JSON w żądaniu RPC służy wyłącznie do transportu walidowanych zmian wierszy.

Funkcja Edge `aco-api` weryfikuje użytkownika w Supabase Auth, sesję w PostgreSQL,
stan konta i rolę. Przeglądarka nie ma bezpośredniego dostępu do tabel domenowych
ani uprzywilejowanych RPC. RLS i odebrane granty wymuszają przejście przez API.
Prywatne notatki, kadry/płace i cudza korespondencja są filtrowane na serwerze.

Transakcje blokują powiązanych klientów/trenerów w ustalonej kolejności, kontrolują
wersje wierszy i zajętość godzin. Nie ma blokady jednej wspólnej rewizji firmy.
Identyfikatory żądań chronią przed powtórnym rozliczeniem tego samego polecenia.
SQL używa parametrów, a nazwy tabel pochodzą z jawnej listy dopuszczalnych tabel.

Czas biznesowy pochodzi z PostgreSQL i wspólnego offsetu. Kontrola sesji, limity
prób i dzierżawy aktywacji korzystają z czasu rzeczywistego. Zdjęcia profilowe
pozostają ograniczonymi rozmiarowo obrazami JPEG w polu `aco_profiles.avatar_path`
(nie jest to publiczny bucket Storage).

## Wersja po audycie

Identyfikator API: `2026-10-07-audit-1`.
Migracja: `20261007155615_audit_resilient_accounts_and_reviews.sql`.
Migracja i funkcja Edge wdrożone 7 października 2026. Publiczny endpoint potwierdził
wersję `2026-10-07-audit-1`. Publikacja panelu następuje przez workflow Pages. Nowy frontend
sprawdza wersję serwera i wyświetla czytelny komunikat przy niezgodności.
Historię migracji stosowanych ręcznie należy uzgodnić przed pierwszym `db push`.

Rejestracja zapisuje w zaufanych metadanych Auth identyfikator i skrót operacji.
Ponowienie tej samej operacji odzyskuje tylko przypisaną jej tożsamość, bez
przejmowania istniejących kont i bez kasowania kont po niepewnym wyniku zapisu.
Aktywacja wiąże kolejne próby z tym samym hasłem za pomocą HMAC oraz dzierżawy
zapisu. Hasło nie jest zapisywane w tabeli aktywacji ani w dzienniku.

Odświeżenie stanu sprawdza sesję oraz znacznik aktualności. Przy braku zmian
przesyła wyłącznie potwierdzenie i czas. Zmiany bazy oraz przekroczenie granic
uprawnień/rezerwacji unieważniają znacznik. Większe odpowiedzi mogą korzystać
z gzip. Dziennik renderuje po 50 zdarzeń. Pierwsze pobranie nadal obejmuje
historię dostępną roli; nie jest to deklaracja pełnego stronicowania danych SQL.

## Weryfikacja

Testy aplikacji, API i PostgreSQL obejmują awarie zapisu Auth, ponowienia rejestracji,
równoległe rezerwacje, prawa ról, prywatność notatek/wiadomości, cofnięte sesje,
zastępstwa, CSV, ważność i ochronę pakietów oraz odświeżanie stanu.
Test wydajności projekcji korzysta z 150 klientów i 15 600 sesji. To test lokalnej
warstwy danych, a nie deklaracja wykonania testu setek jednoczesnych użytkowników
na produkcyjnym planie Supabase Free.

## Integracje

Wpłaty potwierdza administrator; nie ma jeszcze bramki płatności, webhooków,
Fakturowni ani produkcyjnej wysyłki maili. Aktywacja bez maila została wybrana
przez właściciela i zachowuje opisane ograniczenie weryfikacji tożsamości.
Nie ma automatycznego importu danych z lokalnego demo.
