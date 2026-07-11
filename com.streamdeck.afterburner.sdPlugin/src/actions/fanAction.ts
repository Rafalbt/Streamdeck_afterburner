import {
  action,
  SingletonAction,
  type DialAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DialRotateEvent,
  type DialDownEvent,
  type DidReceiveSettingsEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { detectVendor, readFanRpm, fanMinPercent, setFanPercent, restoreAuto } from "../fanControl.js";

/** Per-dial settings. */
interface FanSettings extends JsonObject {
  /** Target fan duty (0-100). */
  targetPct: number;
  /** Whether manual control is engaged (vs. automatic driver/Afterburner curve). */
  manual: boolean;
}

const DEFAULTS: FanSettings = { targetPct: 50, manual: false };
const STEP = 2; // percent per rotation tick
const REFRESH_MS = 1_000;

interface DialState {
  settings: FanSettings;
  timer: ReturnType<typeof setInterval>;
  /** Hardware-enforced minimum manual duty for this GPU. */
  min: number;
}

function clampPct(n: number, min: number): number {
  return Math.max(min, Math.min(100, Math.round(n)));
}

/**
 * Stream Deck + dial control for GPU fan speed.
 *
 * PHASE 2a: the touch strip shows the live fan RPM read via NVAPI (proving the
 * NVAPI plumbing works), plus the target % / auto state. Rotating adjusts the
 * target and pressing toggles manual/auto — but the hardware WRITE is still a
 * stub (`setFanPercent`/`restoreAuto` in fanControl.ts) until Phase 2b.
 */
@action({ UUID: "com.streamdeck.afterburner.fan" })
export class FanAction extends SingletonAction<FanSettings> {
  readonly #dials = new Map<string, DialState>();

  override async onWillAppear(ev: WillAppearEvent<FanSettings>): Promise<void> {
    const dial = ev.action as DialAction<FanSettings>;
    const settings = { ...DEFAULTS, ...ev.payload.settings };
    await dial.setFeedbackLayout("$B1");
    await dial.setTriggerDescription({ rotate: "Fan %", push: settings.manual ? "Auto" : "Manual" });

    const min = detectVendor() === "nvidia" ? fanMinPercent() : 0;
    if (settings.targetPct < min) settings.targetPct = min;

    const id = dial.id;
    const timer = setInterval(() => void this.#render(dial, id), REFRESH_MS);
    this.#dials.set(id, { settings, timer, min });
    // Re-apply a persisted manual setting when the dial (re)appears.
    if (settings.manual) setFanPercent(settings.targetPct);
    await this.#render(dial, id);
  }

  override onWillDisappear(ev: WillDisappearEvent<FanSettings>): void {
    const state = this.#dials.get(ev.action.id);
    if (state) {
      clearInterval(state.timer);
      // Safety: hand control back to auto when the dial goes away; the manual
      // value stays in settings and is re-applied when it reappears.
      if (state.settings.manual) restoreAuto();
      this.#dials.delete(ev.action.id);
    }
  }

  override async onDialRotate(ev: DialRotateEvent<FanSettings>): Promise<void> {
    const dial = ev.action as DialAction<FanSettings>;
    const state = this.#dials.get(dial.id);
    if (!state) return;
    state.settings.targetPct = clampPct(state.settings.targetPct + ev.payload.ticks * STEP, state.min);
    state.settings.manual = true;
    await dial.setSettings(state.settings);
    setFanPercent(state.settings.targetPct); // Phase 2b will actually apply this
    await this.#render(dial, dial.id);
  }

  override async onDialDown(ev: DialDownEvent<FanSettings>): Promise<void> {
    const dial = ev.action as DialAction<FanSettings>;
    const state = this.#dials.get(dial.id);
    if (!state) return;
    state.settings.manual = !state.settings.manual;
    if (state.settings.manual) setFanPercent(state.settings.targetPct);
    else restoreAuto();
    await dial.setSettings(state.settings);
    await dial.setTriggerDescription({ rotate: "Fan %", push: state.settings.manual ? "Auto" : "Manual" });
    await this.#render(dial, dial.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<FanSettings>): Promise<void> {
    const state = this.#dials.get(ev.action.id);
    if (!state) return;
    state.settings = { ...DEFAULTS, ...ev.payload.settings };
    await this.#render(ev.action as DialAction<FanSettings>, ev.action.id);
  }

  async #render(dial: DialAction<FanSettings>, id: string): Promise<void> {
    const state = this.#dials.get(id);
    if (!state) return;
    const s = state.settings;
    const rpm = readFanRpm();
    const rpmStr = rpm != null ? ` · ${rpm} rpm` : ` · ${detectVendor()}`;
    await dial.setFeedback({
      title: `GPU fan${rpmStr}`,
      value: s.manual ? `${s.targetPct}%` : "auto",
      indicator: s.targetPct,
    });
  }
}
