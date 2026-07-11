import {
  action,
  SingletonAction,
  type DialAction,
  type WillAppearEvent,
  type DialRotateEvent,
  type DialDownEvent,
  type DidReceiveSettingsEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { detectVendor, setFanPercent, restoreAuto } from "../fanControl.js";

/** Per-dial settings. */
interface FanSettings extends JsonObject {
  /** Target fan duty (0-100). */
  targetPct: number;
  /** Whether manual control is engaged (vs. automatic driver/Afterburner curve). */
  manual: boolean;
}

const DEFAULTS: FanSettings = { targetPct: 50, manual: false };
const STEP = 2; // percent per rotation tick

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Stream Deck + dial control for GPU fan speed.
 *
 * PHASE 1: the dial adjusts a target %, toggles manual/auto, and shows it on the
 * touch strip; the actual hardware write is still a stub in `fanControl.ts`.
 * This lets us verify the encoder UX and vendor detection before the risky FFI.
 */
@action({ UUID: "com.streamdeck.afterburner.fan" })
export class FanAction extends SingletonAction<FanSettings> {
  override async onWillAppear(ev: WillAppearEvent<FanSettings>): Promise<void> {
    const dial = ev.action as DialAction<FanSettings>;
    const s = { ...DEFAULTS, ...ev.payload.settings };
    await dial.setFeedbackLayout("$B1");
    await dial.setTriggerDescription({ rotate: "Fan %", push: s.manual ? "Auto" : "Manual" });
    await this.#render(dial, s);
  }

  override async onDialRotate(ev: DialRotateEvent<FanSettings>): Promise<void> {
    const dial = ev.action as DialAction<FanSettings>;
    const s = { ...DEFAULTS, ...ev.payload.settings };
    s.targetPct = clampPct(s.targetPct + ev.payload.ticks * STEP);
    s.manual = true;
    await dial.setSettings(s);
    setFanPercent(s.targetPct); // Phase 1: stub (logs only)
    await this.#render(dial, s);
  }

  override async onDialDown(ev: DialDownEvent<FanSettings>): Promise<void> {
    const dial = ev.action as DialAction<FanSettings>;
    const s = { ...DEFAULTS, ...ev.payload.settings };
    s.manual = !s.manual;
    if (s.manual) setFanPercent(s.targetPct);
    else restoreAuto();
    await dial.setSettings(s);
    await dial.setTriggerDescription({ rotate: "Fan %", push: s.manual ? "Auto" : "Manual" });
    await this.#render(dial, s);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<FanSettings>): Promise<void> {
    await this.#render(ev.action as DialAction<FanSettings>, { ...DEFAULTS, ...ev.payload.settings });
  }

  async #render(dial: DialAction<FanSettings>, s: FanSettings): Promise<void> {
    const vendor = detectVendor();
    await dial.setFeedback({
      title: `GPU fan · ${vendor}`,
      value: s.manual ? `${s.targetPct}%` : "auto",
      indicator: s.targetPct,
    });
  }
}
