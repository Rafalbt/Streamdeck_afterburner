import streamDeck, {
  action,
  SingletonAction,
  type KeyAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type SendToPluginEvent,
  type PropertyInspectorDidAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { readMahm, findEntry, acquire, release } from "../mahm.js";
import { renderText, renderChart, renderMessage, formatValue, toImage } from "../renderer.js";
import { ActionSettings, withDefaults, HISTORY_MAX } from "../settings.js";

const REFRESH_MS = 1_000;

/** Per-key runtime state (one entry per physical key showing this action). */
interface KeyState {
  settings: ActionSettings;
  history: number[];
  timer: ReturnType<typeof setInterval>;
}

/** Message the Property Inspector sends to request the sensor list. */
interface GetSensorsMessage {
  event: "getSensors";
}

@action({ UUID: "com.hwinfi.afterburner.sensor" })
export class SensorAction extends SingletonAction<ActionSettings> {
  readonly #keys = new Map<string, KeyState>();

  override async onWillAppear(ev: WillAppearEvent<ActionSettings>): Promise<void> {
    acquire();
    const key = ev.action as KeyAction<ActionSettings>;

    let settings = withDefaults(ev.payload.settings);
    // First-time setup: default to the first available sensor and persist it.
    if (!settings.parameterName) {
      const entries = readMahm();
      if (entries && entries.length > 0) {
        settings = { ...settings, parameterName: entries[0].name };
        await key.setSettings(settings);
      }
    }

    const id = key.id;
    const timer = setInterval(() => void this.#tick(key, id), REFRESH_MS);
    this.#keys.set(id, { settings, history: [], timer });

    await this.#tick(key, id);
  }

  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    const state = this.#keys.get(ev.action.id);
    if (state) {
      clearInterval(state.timer);
      this.#keys.delete(ev.action.id);
    }
    release();
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>): Promise<void> {
    const state = this.#keys.get(ev.action.id);
    if (!state) return;

    const next = withDefaults(ev.payload.settings);
    // Clear history when the monitored sensor changes, otherwise the chart would
    // briefly blend samples from two different metrics.
    if (next.parameterName !== state.settings.parameterName) {
      state.history = [];
    }
    state.settings = next;

    await this.#tick(ev.action as KeyAction<ActionSettings>, ev.action.id);
  }

  /** When the PI opens, push the live list of available sensors to it. */
  override async onPropertyInspectorDidAppear(
    _ev: PropertyInspectorDidAppearEvent<ActionSettings>,
  ): Promise<void> {
    await this.#sendSensorList();
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<JsonValue, ActionSettings>,
  ): Promise<void> {
    const msg = ev.payload as Partial<GetSensorsMessage>;
    if (msg?.event === "getSensors") {
      await this.#sendSensorList();
    }
  }

  /** Push the live list of available sensors to the currently-visible PI. */
  async #sendSensorList(): Promise<void> {
    const entries = readMahm() ?? [];
    await streamDeck.ui.sendToPropertyInspector({
      event: "sensors",
      items: entries.map((e) => ({ name: e.name, unit: e.unit })),
    });
  }

  /** One refresh: read the sensor, render, and push the image to the key. */
  async #tick(action: KeyAction<ActionSettings>, id: string): Promise<void> {
    const state = this.#keys.get(id);
    if (!state) return;
    const { settings } = state;

    try {
      const entries = readMahm();
      if (!entries) {
        await action.setImage(toImage(renderMessage("N/A", settings)));
        return;
      }

      const entry = findEntry(entries, settings.parameterName);
      if (!entry) {
        await action.setImage(toImage(renderMessage("N/A", settings)));
        return;
      }

      if (settings.displayMode === "chart") {
        state.history.push(entry.value);
        if (state.history.length > HISTORY_MAX) state.history.shift();
        await action.setImage(toImage(renderChart(state.history, entry.unit, settings)));
      } else {
        await action.setImage(toImage(renderText(formatValue(entry.value), entry.unit, settings)));
      }
    } catch (err) {
      console.error("hwinfi tick error:", err);
      await action.setImage(toImage(renderMessage("ERR", settings)));
    }
  }
}
