# ACO! — stan publikacji i migracji

## Wdrożone 25 września 2026

- Publiczne repozytorium: https://github.com/ACOfitness/demo
- Panel: https://acofitness.github.io/demo/panel.html
- GitHub Actions: https://github.com/ACOfitness/demo/actions/runs/36135481910
- Organizacja Supabase ACO!, projekt `kxbqigvxmrzxaszovdoo` (London).
- Migracja `20260925094836_aco_access_foundation.sql` wykonana przez SQL Editor
  w prywatnej sesji Safari konta ACO!. Nie jest jeszcze zarejestrowana przez CLI
  w historii migracji — przed pierwszym `db push` należy uzgodnić historię,
  a nie wykonywać tego skryptu drugi raz.
- 17 tabel ma RLS. Kontrola w zdalnej bazie: 0 tabel bez RLS,
  0 bezpośrednich uprawnień zapisu dla anon/authenticated w tabelach aplikacji.
- Supabase Security Advisor po ponownym uruchomieniu: 0 błędów, 0 ostrzeżeń.
  Dwie informacje „RLS Enabled No Policy” dotyczą `aco_private.identities`
  oraz `aco_private.audit_log`. To celowe: role przeglądarkowe nie mają
  dostępu do tych tabel; nie dodawać szerokich polityk, aby uciszyć sugestie.
- 44 testy aplikacji oraz 11 testów PostgreSQL/PGlite przechodzą lokalnie.
  GitHub Actions dodatkowo wykonał testy aplikacji i build przed publikacją.
- Sprawdzono zgodność opublikowanych plików źródłowych i sum plików JS/CSS
  z lokalnym buildem oraz otwarcie panelu przez HTTPS.
- Nie przenoszono danych osobowych ani baz z przeglądarki. Nie używano kont Big Bear.

## Obecna strona nadal działa lokalnie

GitHub Pages hostuje obecną wersję zapisującą dane w localStorage.
Nie jest jeszcze połączona z Supabase. Konta i dane nie synchronizują się
między urządzeniami. Przy pierwszym uruchomieniu użytkownik ustawia własne
hasło lokalnego administratora; w źródłach nie ma domyślnego hasła.

Przygotowany schemat Supabase to fundament uprawnień, nie gotowy backend.
Zapis z ról przeglądarkowych jest celowo zablokowany do czasu wdrożenia
walidowanych operacji serwerowych.

## Pozostałe prace przed wersją online

- Supabase Auth, potwierdzanie własności adresu e-mail, aktywacja i odzyskiwanie
  dostępu; bezpieczne utworzenie pierwszego administratora online.
- Zastąpienie localStorage i synchronicznych operacji w interfejsie.
- Transakcyjne rezerwacje, ochrona przed równoczesnym zakupem tego samego
  terminu, walidacja danych, limity żądań i rejestrowanie operacji.
- Serwerowa weryfikacja płatności; symulacja przeglądarkowa nie może wydawać
  opłaconych pakietów w systemie produkcyjnym.
- Prywatne zdjęcia, adresy przekierowań Auth, MFA administracji i kopie bazy.
- Testy rzeczywistych API dla różnych ról i kont, w tym próby przekroczenia
  uprawnień oraz odwołania dostępu po zakończeniu zastępstwa.

Integracja narzędziowa Supabase w Codex nadal odmawia dostępu do tego projektu.
Dostęp przez zalogowane Safari działa. Nie kopiować kluczy service_role do
repozytorium, strony, komunikatów ani localStorage. Nie traktować sprawdzenia
fundamentu RLS jako pełnego testu bezpieczeństwa gotowego systemu.
