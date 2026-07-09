# Plan implementacji: plugin Stream Deck z danymi z MSI Afterburner

## Cel

Plugin Stream Decka pozwalający na każdym klawiszu:
- wybrać dowolny parametr monitorowany przez MSI Afterburner (temperatura, obciążenie, zegar, itd.),
- wyświetlić go jako tekst albo jako mini-wykres,
- skonfigurować kolor tekstu, kolor wykresu i rozmiar tekstu.

Całość działa jako **jeden proces Node.js** — bez osobnego programu pomocniczego. Dane z Afterburnera czytane są bezpośrednio przez `koffi` (FFI), a odczyt trafia do MAHM shared memory (`MAHMSharedMemory`).

## Architektura (skrót)

```
Afterburner (MAHM shared memory)
        │
        ▼
   mahm.ts (odczyt przez koffi)
        │
        ▼
  Instancja akcji (ustawienia + timer co 1s)  ◄──► Property Inspector (pi.html)
        │
        ▼
   SVG renderer (tekst / wykres)
        │
        ▼
   setImage() → klawisz Stream Decka
```

Ustawienia płyną dwukierunkowo między Property Inspectorem a instancją akcji (`getSettings` / `setSettings`), a dane sensorów płyną jednokierunkowo od Afterburnera do klawisza.

---

## Faza 0 — fundament (gotowe)

`mahm.ts` już istnieje i działa: otwiera `MAHMSharedMemory` przez `OpenFileMappingA` + `MapViewOfFile` (koffi), dekoduje strukturę nagłówka i wpisów, zwraca listę `{ name, unit, value }`.

Do zmiany: dotychczasowe `setTitle()` w akcji zostanie zastąpione własnym renderowaniem (patrz Faza 3).

---

## Faza 1 — model ustawień

Każda instancja klawisza (bo tę samą akcję można dodać na kilku klawiszach, monitorując różne parametry) trzyma własny obiekt ustawień, persystowany automatycznie przez Stream Decka:

```typescript
interface ActionSettings {
  parameterName: string;        // dokładna nazwa sensora z MAHM, np. "GPU temperature"
  displayMode: "text" | "chart";
  textColor: string;             // hex, np. "#ffffff"
  chartColor: string;            // hex, np. "#1d9e75"
  textSize: number;              // px, np. 24
}
```

Stream Deck sam zapisuje te dane per-instancja (`getSettings` / `setSettings`) — nie trzeba nic trzymać ręcznie na dysku.

---

## Faza 2 — Property Inspector (UI wyboru)

Osobny plik HTML (`pi.html`), otwierany przez Stream Deck jako panel konfiguracji klawisza:

- **Dropdown parametru** — lista sensorów nie jest hardkodowana (zależy od karty/wersji Afterburnera). Plugin przy pierwszym uruchomieniu robi jednorazowy `readMahm()` i wysyła listę nazw + jednostek do PI; PI buduje `<select>` z realnych danych.
- **Wybór trybu** — proste radio: „Tekst” / „Wykres”.
- **Dwa `<input type="color">`** — kolor tekstu, kolor wykresu (natywny color-picker przeglądarki, zero dodatkowej biblioteki).
- **Suwak rozmiaru tekstu** — `<input type="range">`, np. zakres 10–40px.
- Każda zmiana leci od razu przez `setSettings()`, żeby plugin mógł live-updateować podgląd na klawiszu.

---

## Faza 3 — silnik renderujący (SVG, bez zewnętrznych bibliotek)

`setImage()` w aktualnym SDK przyjmuje bezpośrednio string SVG jako jeden z obsługiwanych formatów obrazu. Dzięki temu nie potrzeba żadnej biblioteki graficznej (`canvas` / `@napi-rs/canvas`) — wystarczy budować SVG jako zwykły template string w czystym TypeScript, bez natywnych zależności do kompilacji. To trzyma się tej samej filozofii co wybór `koffi` wcześniej: zero toolchainu kompilacyjnego.

```typescript
function renderText(value: string, unit: string, s: ActionSettings): string {
  return `<svg viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
    <rect width="72" height="72" fill="#000"/>
    <text x="36" y="36" text-anchor="middle" dominant-baseline="central"
          fill="${s.textColor}" font-size="${s.textSize}">${value}${unit}</text>
  </svg>`;
}

function renderChart(history: number[], s: ActionSettings): string {
  const w = 72, h = 72, pad = 6;
  const min = Math.min(...history), max = Math.max(...history) || 1;
  const range = max - min || 1;
  const pts = history.map((v, i) => {
    const x = pad + (i / (history.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    return `${x},${y}`;
  }).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#000"/>
    <polyline points="${pts}" fill="none" stroke="${s.chartColor}" stroke-width="2"/>
  </svg>`;
}
```

Warto ustawić w manifeście `ShowTitle: false` dla tej akcji, skoro tekst rysujemy sami wewnątrz SVG — inaczej natywny tytuł Stream Decka nakładałby się na własny render.

**Zaleta tego podejścia:** renderer można przetestować całkowicie niezależnie od Stream Decka — wystarczy prosty skrypt node zapisujący wynikowy SVG do pliku i podgląd w przeglądarce.

---

## Faza 4 — pętla aktualizacji w akcji

- `onWillAppear`: wczytaj `ev.payload.settings`, ustaw sensowne wartości domyślne (pierwszy dostępny parametr, tryb tekstowy, biały tekst, zielony wykres, 24px), odpal `setInterval` (co 1s).
- Co tick:
  1. `readMahm()`
  2. `findEntry(entries, settings.parameterName)`
  3. jeśli `displayMode === "chart"` — dopisz wartość do bufora historii (stała długość, np. 30–60 próbek, FIFO) i wywołaj `renderChart`
  4. jeśli `"text"` — wywołaj `renderText`
  5. `ev.action.setImage(svg)`
- `onDidReceiveSettings`: zaktualizuj lokalny stan akcji; **wyczyść bufor historii, jeśli zmienił się `parameterName`** (inaczej wykres na chwilę pokaże miksankę dwóch różnych metryk).
- `onWillDisappear`: `clearInterval`.

---

## Faza 5 — wiele instancji jednocześnie

`mahm.ts` trzyma jeden globalny uchwyt do shared memory, a użytkownik może dodać tę akcję na kilku klawiszach naraz (różne parametry na każdym). Uchwyt można bezpiecznie współdzielić między instancjami (sam odczyt niczego nie mutuje), ale zamykać go (`closeMahm`) trzeba dopiero gdy **ostatnia** aktywna instancja zniknie. Potrzebny prosty licznik aktywnych instancji w module `mahm.ts`.

---

## Faza 6 — edge case'y do ogarnięcia

- Afterburner nie jest uruchomiony → `setImage` z komunikatem "N/A" zamiast wywalenia błędu w całym pluginie.
- Wybrany parametr zniknął z listy (np. inna wersja sterownika/karty) → ten sam fallback.
- Throttling odświeżania obrazka do ~1/s — Stream Deck i tak nie potrzebuje częstszych aktualizacji wizualnych.

---

## Faza 7 (opcjonalnie, na później)

Progi kolorystyczne (np. tekst na czerwono, gdy temperatura > 80°C) — naturalne rozszerzenie, skoro i tak SVG generowane jest w locie. Wykracza poza obecny zakres, ale warto mieć z tyłu głowy jako łatwy kolejny krok.

---

## Sugerowana kolejność prac

1. **Faza 1** — schemat ustawień (`ActionSettings`)
2. **Faza 3** — renderer SVG (najłatwiej przetestować w izolacji, bez Stream Decka)
3. **Faza 4** — spięcie renderera z `mahm.ts` i pętlą aktualizacji
4. **Faza 5 i 6** — obsługa wielu instancji i edge case'y
5. **Faza 2** — Property Inspector na końcu (bez działającego backendu nie ma czego konfigurować)

## Rzeczy do zweryfikowania podczas implementacji

- Dokładny layout struktury MAHM (rozmiary/kolejność pól) — porównać z nagłówkiem SDK dostarczanym z instalacją Afterburnera.
- Realne nazwy sensorów w `MAHMSharedMemory` — zależą od wersji Afterburnera i karty graficznej, najlepiej zrzucić listę raz na start.
- Dokładne nazwy zdarzeń/metod w aktualnej wersji `@elgato/streamdeck` (np. `onDidReceiveSettings`, `onWillDisappear`) — potwierdzić w typach IDE, bo SDK bywa aktualizowany.
