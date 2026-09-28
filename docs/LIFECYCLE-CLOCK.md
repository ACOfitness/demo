# ACO! - konto i czas testowy

Administrator usuwa konto z karty klienta lub listy trenerów. Dialog oferuje archiwizację (blokada logowania, zachowanie historii) i trwałe usunięcie potwierdzane wpisaniem USUŃ. Widok archiwum pozwala ponownie otworzyć dialog.

Trener musi mieć zero przypisanych klientów i brak nierozliczonych sesji/rezerwacji. Trwałe usunięcie trenera mającego historię istniejących klientów jest zabronione: użyj archiwizacji albo usuń wcześniej testowych klientów. Zapobiega to zmianie salda wejść wskutek kasowania sesji.

Skrót Cmd/Ctrl+Shift+Y otwiera administratorowi dialog czasu. `aco_private.test_clock.time_offset_seconds` jest jedynym źródłem przesunięcia. Czas biznesowy płynie dalej, a reset ustawia offset na zero. Cofnięcie czasu nie odwraca płatności, rozliczeń ani wygasłych rezerwacji. Auth, sesje, limity prób, identyfikatory transakcji i audit bezpieczeństwa używają rzeczywistego czasu.

Zmiany czasu i cyklu życia kont otrzymują wyłączną blokadę względem współbieżnych zapisów. Zwykłe operacje współdzielą blokadę i weryfikują wersję zegara. Idempotencja chroni ponowienia; czyszczenie Auth można ponowić po niepewnej odpowiedzi sieci. Zablokowane konto traci dostęp natychmiast po zatwierdzeniu transakcji domenowej, przed czyszczeniem Auth.

Brak bezpośrednich uprawnień przeglądarki do nowych tabel i funkcji. Funkcje dostępne wyłącznie backendowi, który weryfikuje Auth i rolę; funkcje SQL ponownie sprawdzają sesję administratora. Zdjęcia pozostają w `aco_profiles.avatar_path` (data URL), więc trwałe usunięcie profilu usuwa również zdjęcie. Techniczny audit operacji pozostaje; usunięcie nie usuwa kopii zapasowych dostawcy.

Tryb testowy jest włączony dla obecnego środowiska testów ACO!. Przed uruchomieniem produkcyjnym ustawić offset=0 i enabled=false w `aco_private.test_clock` po zakończeniu testów.
