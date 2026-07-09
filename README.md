# MSI Afterburner Sensors — plugin Stream Deck

Plugin Elgato Stream Deck, który wyświetla dowolny czujnik monitorowany przez **MSI Afterburner** (temperatura, obciążenie, zegar, obroty wentylatora, zużycie pamięci itd.) na klawiszu — jako tekst albo mini-wykres.

Każdy klawisz może niezależnie monitorować inny parametr. Plugin działa jako **jeden proces Node.js** — bez osobnego programu pomocniczego. Dane czytane są bezpośrednio z pamięci współdzielonej Afterburnera (`MAHMSharedMemory`) przez `koffi` (FFI), a obraz klawisza budowany jest jako **SVG** — bez bibliotek graficznych.

> ⚠️ **Windows only.** Pamięć `MAHMSharedMemory` udostępnia wyłącznie MSI Afterburner na Windows.

---

## Funkcje

- 🌡️ **Dowolny czujnik** — lista sensorów pobierana jest na żywo z Afterburnera (zależy od karty i wersji), nic nie jest zahardkodowane
- 📝 **Tryb tekstowy** — bieżąca wartość + jednostka
- 📈 **Tryb wykresu** — mini-wykres liniowy z historii ostatnich ~50 odczytów
- 🎯 **Zakres osi Y wykresu** — auto-skalowanie do danych, albo własne granice min/max wpisane przez użytkownika (np. 30–85)
- 🏷️ **Własny label** — mniejszy tekst pod wartością (np. „GPU", „CPU")
- ↕️ **Pozycja wartości** — góra / środek / dół (label podąża pod wartością)
- 🎨 **Konfigurowalne kolory** tekstu i wykresu oraz rozmiar tekstu
- 🌈 **Wypełnienie pod wykresem** — gradient najmocniejszy tuż przy linii, zanikający w dół (kolorem wykresu)
- 🔢 **Wiele klawiszy naraz** — ta sama akcja na kilku klawiszach, każdy z innym czujnikiem
- 🛡️ **Odporność na braki** — gdy Afterburner nie działa lub czujnik zniknął, klawisz pokazuje `N/A` zamiast się wywalać

---

## Wymagania

- **Windows 10/11**
- **MSI Afterburner** uruchomiony, z włączonym monitoringiem sprzętu (to on tworzy `MAHMSharedMemory`)
- **Stream Deck** (aplikacja Elgato 6.5+)
- **Node.js 20+** (do zbudowania pluginu)

---

## Instalacja

```bash
git clone https://github.com/Rafalbt/Streamdeck_afterburner.git
cd Streamdeck_afterburner

# 1) zależności do budowania (SDK, esbuild, TypeScript)
npm install

# 2) zależność runtime (koffi) obok wtyczki — wymagane, bo koffi jest natywne
cd com.hwinfi.afterburner.sdPlugin && npm install && cd ..

# 3) zbuduj plugin (src/plugin.ts -> bin/plugin.js)
npm run build

# 4) zarejestruj wtyczkę w Stream Decku
npm run link
```

Po `npm run link` w Stream Decku, na liście akcji po prawej, pojawi się kategoria **„MSI Afterburner Sensors"** z akcją **„Sensor"**. Przeciągnij ją na wolny klawisz.

---

## Użycie

1. Upewnij się, że **MSI Afterburner działa** (inaczej klawisz pokaże `N/A`, a lista czujników będzie pusta).
2. Przeciągnij akcję **„Sensor"** na klawisz.
3. Zaznacz klawisz — w panelu konfiguracji (Property Inspector) ustaw:

| Opcja | Opis |
|-------|------|
| **Sensor** | Czujnik do wyświetlenia (lista z Afterburnera) |
| **Display** | `Text` (wartość) lub `Chart` (mini-wykres) |
| **Label** | Opcjonalny tekst pod wartością (puste = ukryty) |
| **Value position** | Pozycja wartości: `Top` / `Center` / `Bottom` |
| **Text color** | Kolor tekstu wartości/labela |
| **Chart color** | Kolor linii wykresu |
| **Text size** | Rozmiar tekstu wartości (10–40) |
| **Chart range → Auto scale** | Auto-skalowanie osi Y do danych (domyślnie wł.) |
| **Chart range → Min / Max** | Własne granice osi Y wpisane przez użytkownika (aktywne, gdy „Auto scale" wyłączone) |

Zmiany widać na klawiszu na żywo. Odświeżanie odczytu następuje co 1 sekundę.

---

## Rozwój

```bash
npm run build      # bundle jednorazowy (esbuild)
npm run watch      # bundle w trybie watch
npm run typecheck  # sprawdzenie typów (esbuild NIE sprawdza typów!)
npm run validate   # walidacja manifestu Stream Decka
npm run icons      # regeneracja ikon PNG w imgs/
npm run restart    # restart wtyczki w Stream Decku po przebudowie
npm run dev        # tryb deweloperski Elgato CLI (hot reload)
```

Typowy cykl: `npm run watch` w tle + `npm run restart` po zmianach w kodzie pluginu. Zmiany w `ui/pi.html` wystarczy podejrzeć po ponownym otwarciu panelu.

---

## Jak to działa

```
MSI Afterburner (MAHMSharedMemory)
        │  koffi FFI (OpenFileMappingA + MapViewOfFile)
        ▼
   mahm.ts  ── readMahm() -> { name, unit, value }[] | null
        │
        ▼
  SensorAction (timer + bufor historii per klawisz, kluczowane po action.id)  ◄──► ui/pi.html
        │
        ▼
   renderer.ts (renderText / renderChart -> string SVG -> data URI)
        │
        ▼
   key.setImage(dataUri)
```

- **`src/mahm.ts`** — otwiera pamięć współdzieloną, parsuje nagłówek (`dwHeaderSize`/`dwNumEntries`/`dwEntrySize`) i wpisy, zwraca listę czujników. Jeden uchwyt współdzielony między klawiszami z licznikiem referencji.
- **`src/renderer.ts`** — buduje obraz klawisza jako SVG (72×72), pakuje do `data:image/svg+xml`.
- **`src/settings.ts`** — model ustawień per-klawisz + wartości domyślne.
- **`src/actions/sensorAction.ts`** — jedna instancja `SingletonAction` obsługuje wszystkie klawisze; stan (timer, historia, ustawienia) trzymany w mapie po `action.id`.
- **`ui/pi.html`** — panel konfiguracji (surowy protokół WebSocket Stream Decka, bez frameworka).

Więcej szczegółów architektonicznych i pułapek SDK: **[CLAUDE.md](CLAUDE.md)**.

---

## Struktura projektu

```
Streamdeck_afterburner/
├─ com.hwinfi.afterburner.sdPlugin/   # właściwa wtyczka
│  ├─ manifest.json
│  ├─ bin/launcher.bat                # (bin/plugin.js budowany lokalnie)
│  ├─ imgs/                           # ikony PNG (@1x/@2x)
│  ├─ ui/pi.html                      # Property Inspector
│  └─ src/                            # źródła TypeScript
├─ tools/gen-icons.cjs                # generator ikon PNG
├─ package.json                       # skrypty budowania
├─ tsconfig.json
└─ CLAUDE.md                          # notatki architektoniczne
```

---

## Rozwiązywanie problemów

- **Wtyczka nie pojawia się w Stream Decku** → uruchom `npm run validate`. Stream Deck po cichu odrzuca wtyczkę z błędnym manifestem. Potem `npm run restart` i sprawdź logi w `com.hwinfi.afterburner.sdPlugin/logs/`.
- **Klawisz pokazuje `N/A`** → MSI Afterburner nie działa lub ma wyłączony monitoring; ewentualnie wybrany czujnik zniknął z listy.
- **Lista czujników pusta w konfiguracji** → jak wyżej — uruchom Afterburner przed otwarciem panelu.

---

## Podziękowania

Odczyt układu `MAHMSharedMemory` oparty na nagłówku z Remote Server SDK MSI Afterburnera. Wzorzec budowania (esbuild + Elgato CLI) inspirowany siostrzanym projektem `d4-streamdeck`.
