# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Elgato Stream Deck plugin that displays MSI Afterburner hardware sensors (temperatures, loads, clocks, ...) on keys. Each key independently monitors one sensor and renders it as text or a mini line-chart, with configurable colors and text size.

Runs as a **single Node.js process** — no helper binary. Sensor data is read directly from MSI Afterburner's `MAHMSharedMemory` shared memory via `koffi` (FFI). Key images are built as **SVG strings** — no canvas/native graphics library.

`plan-implementacji-streamdeck-afterburner.md` (Polish) is the original design doc/roadmap. Sibling project `D:\dev\d4-streamdeck` is a working plugin using the same SDK and the esbuild/launcher build model this project copies.

## Commands

```bash
npm run build      # esbuild bundle src/plugin.ts -> bin/plugin.js (koffi kept external)
npm run watch      # build in watch mode
npm run typecheck  # tsc --noEmit (build does NOT type-check; run this separately)
npm run validate   # @elgato/cli manifest validation — RUN THIS if the plugin won't load
npm run icons      # regenerate PNG icons in imgs/ (uses @napi-rs/canvas, dev-only)
npm run dev        # @elgato/cli: run plugin with hot reload
npm run link       # register the .sdPlugin folder with Stream Deck
npm run restart    # restart the plugin in Stream Deck after a rebuild
```

**If the plugin doesn't appear in Stream Deck**, run `npm run validate` first — Stream Deck silently refuses to load a plugin whose manifest fails validation. Then `npm run restart`, and check `com.streamdeck.afterburner.sdPlugin/logs/` for the plugin process output.

**Dependencies install in two places**: `npm install` at the repo root (SDK, esbuild, TS), *and* `npm install` inside `com.streamdeck.afterburner.sdPlugin/` (installs `koffi` so it resolves at runtime next to the bundled `bin/plugin.js`, and ships with a packaged plugin).

**Smoke-testing `mahm.ts` in isolation** (dumps the live sensor list, or reports unavailable — needs Afterburner running with monitoring on):
```bash
npx esbuild com.streamdeck.afterburner.sdPlugin/src/test-mahm.ts --bundle --platform=node \
  --target=node20 --format=cjs --external:koffi \
  --outfile=com.streamdeck.afterburner.sdPlugin/bin/test-mahm.cjs
node com.streamdeck.afterburner.sdPlugin/bin/test-mahm.cjs   # must run from a dir where koffi resolves
```

## Architecture

```
MSI Afterburner (MAHMSharedMemory)
        │  koffi FFI (OpenFileMappingA + MapViewOfFile)
        ▼
   mahm.ts  ── readMahm() -> {name,unit,value}[] | null
        │
        ▼
  SensorAction (one timer + history buffer PER key, keyed by action.id)  ◄──► ui/pi.html
        │
        ▼
   renderer.ts (renderText / renderChart / renderMessage -> SVG string -> toImage data URI)
        │
        ▼
   key.setImage(dataUri)
```

### Files (`com.streamdeck.afterburner.sdPlugin/src/`)

- **`mahm.ts`** — Reads the shared memory. Parses the header to get `dwHeaderSize`/`dwNumEntries`/`dwEntrySize`, then strides entries dynamically (robust across Afterburner versions). Values live at a fixed intra-entry offset (`1300`, after five `char[260]` fields). Holds one global handle shared by all keys; `acquire()`/`release()` ref-count it and `closeMahm()` fires only when the last key disappears. Returns `null` when Afterburner is absent or its data isn't ready (signature != `'MAHM'`).
- **`renderer.ts`** — Pure SVG template strings in a 72×72 coordinate space. `toImage()` wraps SVG as a base64 `data:image/svg+xml` URI for `setImage`.
- **`settings.ts`** — `ActionSettings` (persisted per-key by Stream Deck), `DEFAULTS`, `withDefaults()`, `HISTORY_MAX`.
- **`actions/sensorAction.ts`** — `SingletonAction` handling all keys. Because one instance serves every key, all per-key state (timer, history, settings) is stored in a `Map` keyed by `action.id`. First appearance with no sensor set defaults to the first available sensor and persists it. `onDidReceiveSettings` clears the history buffer when `parameterName` changes (otherwise the chart blends two metrics).
- **`plugin.ts`** — registers the action and calls `streamDeck.connect()`.
- **`ui/pi.html`** — Property Inspector. Raw Stream Deck websocket protocol (no UI framework). Requests the sensor list from the plugin (`sendToPlugin {event:"getSensors"}`), builds the `<select>` from the reply, and pushes every change via `setSettings` for live preview.

## SDK Gotchas (learned the hard way — don't re-discover these)

- **Standard (TC39) decorators, NOT `experimentalDecorators`.** `@elgato/streamdeck`'s `action` decorator is typed `(target, context) => ...`. Setting `experimentalDecorators: true` in tsconfig breaks it with a "decorator expects 2 arguments" error. Leave it off.
- **JSON types come from `@elgato/utils`, not `@elgato/streamdeck`.** `JsonObject`/`JsonValue` are not re-exported by the SDK. `ActionSettings` must `extends JsonObject` (from `@elgato/utils`) or the `SingletonAction<T extends JsonObject>` constraint fails and cascades into a confusing decorator error. `@elgato/utils` is a direct dependency for this reason.
- **`sendToPropertyInspector` is on the global `streamDeck.ui`, not on the action.** Use `streamDeck.ui.sendToPropertyInspector(payload)` — it targets the currently-visible PI (correct, since the relevant events only fire for the focused action).
- **`ev.action` is `DialAction | KeyAction`.** This is a keypad-only action, so narrow with `as KeyAction<ActionSettings>` for key-only methods like `setImage`.
- **`koffi` must be `--external` in esbuild** (native module) and resolvable at runtime from `bin/` — hence the inner `package.json` + install.
- **esbuild does not type-check.** A green `npm run build` says nothing about types; run `npm run typecheck`.

## Implementation Notes

- **Manifest requires a top-level `UUID`** (`com.streamdeck.afterburner`) matching the `.sdPlugin` folder, and `URL` must be a valid http(s) URL or omitted entirely — an empty string fails validation.
- Manifest sets `ShowTitle: false` / `UserTitleEnabled: false` because the plugin draws its own text inside the SVG; the native title would overlap.
- **Manifest icons must be PNG, not SVG** (with `@2x` variants). SVG is only accepted at *runtime* via `setImage`. Icons are generated by `tools/gen-icons.cjs` (`npm run icons`). Sizes: plugin/state = 72+144, category = 28+56, action = 20+40.
- Sensor names/units are ANSI (CP-1252) in shared memory; `mahm.ts` decodes them as latin1 so symbols like `°C` survive without a dependency.
- Sensor names are **never hardcoded** — they vary by GPU and Afterburner version; the list is always read live from `readMahm()`.
- Live sensor decoding can only be verified with Afterburner running; without it `readMahm()` returns `null` and keys show `N/A`.
