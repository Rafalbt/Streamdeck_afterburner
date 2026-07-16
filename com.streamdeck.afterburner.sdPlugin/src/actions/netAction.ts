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
import type { JsonObject, JsonValue } from "@elgato/utils";

import { listInterfaces, readOctets } from "../net.js";
import { renderText, renderChart, renderMessage, formatValue, toImage } from "../renderer.js";
import type { ActionSettings } from "../settings.js";
import { HISTORY_MAX } from "../settings.js";

/** Per-key settings for a network throughput action. */
interface NetSettings extends JsonObject {
  /** Interface id (InterfaceIndex as string), or "all" to sum every adapter. */
  iface: string;
  displayMode: "text" | "chart";
  textColor: string;
  chartColor: string;
  textSize: number;
  bgColor: string;
  label: string;
  valuePosition: "top" | "center" | "bottom";
  chartAuto: boolean;
  chartMin: number;
  chartMax: number;
}

const DEFAULTS: NetSettings = {
  iface: "all",
  displayMode: "text",
  textColor: "#ffffff",
  chartColor: "#4aa3ff",
  textSize: 22,
  bgColor: "#000000",
  label: "",
  valuePosition: "center",
  chartAuto: true,
  chartMin: 0,
  chartMax: 100,
};

const REFRESH_MS = 1_000;

/** Pick a display unit (bytes/s stays the stored value; unit drives formatting). */
function rateUnit(bytesPerSec: number): string {
  if (bytesPerSec >= 2 ** 30) return "GB/s";
  if (bytesPerSec >= 2 ** 20) return "MB/s";
  return "KB/s";
}

interface NetState {
  settings: NetSettings;
  history: number[];
  last: { rx: number; tx: number; time: number } | null;
  timer: ReturnType<typeof setInterval>;
}

/**
 * Base for the download/upload actions. Samples the selected interface's byte
 * counters each second and renders the rate (bytes/s) as text or a chart.
 * `direction` selects received (download) vs sent (upload).
 */
abstract class NetActionBase extends SingletonAction<NetSettings> {
  protected abstract readonly direction: "rx" | "tx";
  readonly #keys = new Map<string, NetState>();

  override async onWillAppear(ev: WillAppearEvent<NetSettings>): Promise<void> {
    const key = ev.action as KeyAction<NetSettings>;
    const settings = { ...DEFAULTS, ...ev.payload.settings };
    const id = key.id;
    const timer = setInterval(() => void this.#tick(key, id), REFRESH_MS);
    this.#keys.set(id, { settings, history: [], last: null, timer });
    await this.#tick(key, id);
  }

  override onWillDisappear(ev: WillDisappearEvent<NetSettings>): void {
    const state = this.#keys.get(ev.action.id);
    if (state) {
      clearInterval(state.timer);
      this.#keys.delete(ev.action.id);
    }
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<NetSettings>): Promise<void> {
    const state = this.#keys.get(ev.action.id);
    if (!state) return;
    const next = { ...DEFAULTS, ...ev.payload.settings };
    if (next.iface !== state.settings.iface) {
      state.history = [];
      state.last = null;
    }
    state.settings = next;
    await this.#tick(ev.action as KeyAction<NetSettings>, ev.action.id);
  }

  override async onPropertyInspectorDidAppear(
    _ev: PropertyInspectorDidAppearEvent<NetSettings>,
  ): Promise<void> {
    await this.#sendInterfaces();
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, NetSettings>): Promise<void> {
    const msg = ev.payload as { event?: string };
    if (msg?.event === "getInterfaces") await this.#sendInterfaces();
  }

  async #sendInterfaces(): Promise<void> {
    await streamDeck.ui.sendToPropertyInspector({ event: "interfaces", items: listInterfaces() });
  }

  async #tick(action: KeyAction<NetSettings>, id: string): Promise<void> {
    const state = this.#keys.get(id);
    if (!state) return;
    const { settings } = state;
    try {
      const octets = readOctets(settings.iface);
      const now = Date.now();
      if (!octets) {
        await action.setImage(toImage(renderMessage("N/A", asRender(settings))));
        return;
      }

      let bytesPerSec = 0;
      if (state.last) {
        const dt = (now - state.last.time) / 1000;
        if (dt > 0) {
          const delta = this.direction === "rx" ? octets.rx - state.last.rx : octets.tx - state.last.tx;
          bytesPerSec = Math.max(0, delta / dt); // guard counter resets
        }
      }
      state.last = { rx: octets.rx, tx: octets.tx, time: now };

      const unit = rateUnit(bytesPerSec);
      if (settings.displayMode === "chart") {
        state.history.push(bytesPerSec);
        if (state.history.length > HISTORY_MAX) state.history.shift();
        await action.setImage(toImage(renderChart(state.history, unit, asRender(settings))));
      } else {
        await action.setImage(toImage(renderText(formatValue(bytesPerSec, unit), unit, asRender(settings))));
      }
    } catch (err) {
      console.error("net tick error:", err);
      await action.setImage(toImage(renderMessage("ERR", asRender(settings))));
    }
  }
}

/** The renderer only reads visual fields; NetSettings supplies all of them. */
function asRender(s: NetSettings): ActionSettings {
  return s as unknown as ActionSettings;
}

@action({ UUID: "com.streamdeck.afterburner.netdown" })
export class NetDownAction extends NetActionBase {
  protected readonly direction = "rx" as const;
}

@action({ UUID: "com.streamdeck.afterburner.netup" })
export class NetUpAction extends NetActionBase {
  protected readonly direction = "tx" as const;
}
