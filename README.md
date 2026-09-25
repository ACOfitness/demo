# ACO! — panel treningów personalnych

Uruchomienie: `pnpm install`, `pnpm dev`.
Budowanie: `pnpm build`, `node build-offline.mjs`.
Testy: `pnpm test`.

## Konta i rejestracja

Administrator lokalny: `administrator@aco.pl`. Przy pierwszym uruchomieniu użytkownik ustawia własne hasło. W kodzie nie ma domyślnego hasła.

Obecna wersja przechowuje dane wyłącznie w przeglądarce. Publikacja na Pages nie zmienia jej w system wieloużytkownikowy. Integracja Supabase pozostaje w przygotowaniu; szczegóły: [stan migracji](docs/MIGRATION-STATUS.md).
Klient rejestruje konsultację wraz z datą urodzenia. Od 30 minut po rozpoczęciu konsultacji trener może zatwierdzić konto lub oznaczyć nieobecność. Zatwierdzenie jednocześnie zapisuje produkt i intensywność; późniejsza zmiana produktu jest zablokowana. Aktywacja wymaga e-maila, daty urodzenia i dwukrotnego wpisania hasła. Nie ma kodów ani wysyłki poczty. Administrator może zatwierdzić klienta wcześniej po dodatkowym potwierdzeniu.

Starsze konta zachowują dane. Datę urodzenia starszego klienta administrator uzupełnia w jego karcie — system jej nie zgaduje. Loginy i hasła dotychczas aktywnych kont pozostają bez zmian.

## Trenerzy

Administrator tworzy i edytuje konto, produkty (Trening personalny / Powrót do zdrowia), osobne stawki godzinowe, dane kontaktowe i księgowe, zdjęcie. Opcjonalna zmiana hasła wymaga jego powtórzenia.
Dni, godziny i niedostępności ustawia administrator. Nowy trener zaczyna z pustym grafikiem. Edycja danych osobowych nie nadpisuje dostępności.
Zmiany dostępności nie mogą kolidować z wizytami i rezerwacjami. Przeniesienie klienta wymaga nowego prowadzącego obsługującego jego produkt i dostępnego na przyszłe wizyty. Nie pozostawia klienta bez trenera. Usunięcie z zespołu blokuje logowanie, zachowując historię i korespondencję. Wymaga braku klientów oraz nierozliczonych spotkań i rezerwacji.

## Wiadomości

Foldery: Otrzymane, Wysłane, Powiadomienia. Administrator może pisać do każdego; trener do administratora i własnych klientów; klient do administratora i prowadzącego. Stara korespondencja pozostaje dostępna uczestnikom po zmianie prowadzącego. Administrator nie widzi cudzej prywatnej korespondencji. Powiadomienia administratora obejmują notatki trenerów, nieaktywne konta i nieopłacone rezerwacje.

## Wygląd

Zastosowano ACO_BrandBook.pdf: Coral #F05A47, Graphite #202428, Warm Off-white #F7F5F0, Sora 800 dla nagłówków, Inter dla interfejsu. Oryginalne logotypy wyodrębniono z PDF. Fonty i licencje OFL znajdują się w src/assets/brand, pochodzą z google/fonts (ofl/sora, ofl/inter). Fonty oraz logo są osadzone w zbudowanej stronie i działają offline. Zachowano wcześniejsze zaokrąglenia, karty, przyciski i odstępy z src/style.css; src/brand.css nakłada logo, fonty i paletę ACO.

## Dane lokalne

Baza: localStorage `aco-panel-v2`; sesja: sessionStorage `aco-session`. Starszy klucz `aco-demo-v1` nie jest modyfikowany ani importowany. Konta i dane działają w tej samej przeglądarce pod tym samym adresem. Hasła: PBKDF2-SHA256. Brak płatności, Supabase, e-maili i zewnętrznych połączeń podczas działania aplikacji.
To implementacja lokalna; przed produkcją niezbędne są uwierzytelnianie serwerowe, RLS, transakcje rezerwacji, płatności i integracje. Lokalna identyfikacja przez datę urodzenia realizuje ustalony przepływ, nie zastępuje produkcyjnej weryfikacji tożsamości. Dane księgowe i zdjęcia są również lokalne.

## Czas testowy

Cmd+Shift+T (lub Ctrl+Shift+T) otwiera zegar. Wskazana data i godzina zostają zamrożone do „Przywróć czas rzeczywisty”. Ustawienie `aco-test-clock-v1` obowiązuje dla wszystkich kont i kart tego samego adresu, także po odświeżeniu. Powrót zegara nie cofa zapisanych operacji.

## Pliki

`panel.html` i `../ACO-panel.html` zawierają panel z osadzonymi zasobami. Starszy adres `demo-offline.html` jest kopią zgodności.

Wspólny interfejs: jaśniejsze powierzchnie, profil z edycją danych i zdjęcia dla każdej roli oraz dymek ostatnich powiadomień. Administrator: kompaktowa tabela trenerów, karty produktów ze stawkami oraz osobne ustawienia cen i czasu. Kwoty edycyjne są formatowane po polsku.

Zdjęcia profilowe: kadrowanie po wczytaniu i przy edycji, przesuwanie, przybliżenie oraz okrągły podgląd. Wynik jest zapisywany jako JPEG 512×512. Lewy pasek ma ciepłe tło marki, powiadomienia mają dymek wskazujący dzwonek.

Dostępność: osobne zakresy od–do na każdy dzień, domyślnie jeden, maksymalnie trzy. Przerwy są uwzględniane przy rezerwacji, zakresy nie mogą się nakładać. Zmiany nie mogą naruszać istniejących wizyt. Okna formularzy ostrzegają przed odrzuceniem niezapisanych zmian. Alert dostępności ma osobny blok nad nagłówkiem.


Aktualizacja zarządzania (wrzesień 2026):
- Administrator ustawia dostępność i blokady trenerów. Blokady mogą być widoczne jako zajęte lub ukryte u klientów.
- Nowe konta trenerów mają hasło tymczasowe. Administrator nie edytuje późniejszego hasła, tylko generuje reset wymagający zmiany przy logowaniu. Wcześniej utworzone konta zachowują dostęp; reset również uruchamia obowiązkową zmianę.
- Cennik obejmuje sześć cen całych pakietów (dwa produkty × trzy intensywności) oraz konsultację. Migracja wylicza domyślne ceny z poprzedniego cennika; administrator może nadać każdemu pakietowi inną cenę. Cena przy zakupie pochodzi z aktualnego cennika; opłacone pakiety i sprzedaż nie są przeliczane.
- Edytowalne parametry: długość cyklu, ważność, rezerwacje, ochrona stałych godzin, horyzont konsultacji (domyślnie 7 dni), rozpoczęcia (14 dni), przedłużenia, dostęp zastępcy. W horyzoncie rozpoczęcia musi zmieścić się liczba pierwszych treningów równa intensywności tygodniowej. Zmiana długości cyklu wymaga ponownego wyboru terminów nieopłaconej rezerwacji.
- Wiadomości: grupy uprawnionych odbiorców, osobne kopie, skróty, status odczytania, filtry, pełna treść i odpowiedzi; dzwonek uwzględnia nowe wiadomości.
- Kalendarz pokazuje tylko godziny pracy i istniejące sesje, z wyraźnymi przerwami; administrator ma „Grafik trenerów”. Trener przełącza dni w podsumowaniu.
- Publiczne notatki i komentarze są mocno oznaczone, prywatne notatki wydzielone. Szczegóły mają nawigację wstecz i błędy wyświetlane wewnątrz okna.


## Zakup, promocje i rozliczenia

- Najwyżej jeden trening dziennie. Wybór terminów pokazuje daty kalendarzowe i dzień startowy.
- Po wyborze terminów i ewentualnych wyjątków klient przechodzi bezpośrednio do płatności. Wtedy rozpoczyna się rezerwacja terminów (domyślnie 15 minut).
- Kolejny pakiet można kupić domyślnie 7 dni przed końcem nominalnego cyklu, niezależnie od przedłużonej ważności. Parametr jest edytowalny w ustawieniach.
- Opisy produktów: edytor nazwy, podtytułu i osobnych punktów z podglądem karty na żywo i przełączaniem intensywności. Szkice obu produktów pozostają zachowane podczas przełączania zakładek edytora.
- Promocje: osobne panele rabatów imiennych i kodów, wyszukiwarki oraz historia nieaktywnych promocji. Rabat przypisany do e-maila jest widoczny już w sklepie. Kod wpisuje się przy płatności; ma limit użyć i datę ważności. Rabaty nie sumują się — obowiązuje korzystniejszy. Cena i rabat są zapisywane w opłaconym pakiecie.
- Trenerzy → Dodatkowe godziny: administrator dopisuje godziny, stawkę, opis i miesiąc rozliczenia bez tworzenia wizyt. Okno pokazuje historię wybranego trenera w miesiącu.
- Podsumowania oddzielają treningi, konsultacje i pozostałą pracę. Prognoza miesięczna obejmuje naliczone kwoty oraz przyszłe zaplanowane sesje.
- Powiadomienie o możliwości aktywowania konta jest kierowane tylko do klienta.

Aktualizacja UX: dwie karty produktów z edycją treści po kliknięciu; dwa równe formularze promocji i wspólna lista aktywnych promocji poniżej. Ustawienia podzielono na Cennik, Pakiety, Rezerwacje oraz Zmiany i dostęp. Akcje przy trenerach mają ikony, obramowanie i stany najechania.

Aktualizacja kalendarza i dziennika: odwołanie przez trenera zwalnia wejście bez automatycznego przedłużenia ważności. Administrator zmienia datę ważności wybranego pakietu w karcie klienta; skrócenie nie może pozostawić zaplanowanych wizyt poza pakietem. Kalendarz klienta blokuje dodawanie treningów bez nieprzypisanych wejść i kończy dostępne dni na ważności pakietów. Dziennik jest pionową osią czasu sesji, zakupów i powiadomień z filtrami typu, klienta i okresu.
