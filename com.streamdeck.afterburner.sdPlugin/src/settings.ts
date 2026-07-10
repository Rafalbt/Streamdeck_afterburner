import type { JsonObject } from "@elgato/utils";

/** Per-key settings, persisted automatically by Stream Deck (getSettings/setSettings). */
export interface ActionSettings extends JsonObject {
  /** Exact MAHM sensor name, e.g. "GPU temperature". Empty until first configured. */
  parameterName: string;
  displayMode: "text" | "chart";
  /** Hex color for the value text, e.g. "#ffffff". */
  textColor: string;
  /** Hex color for the chart line, e.g. "#1d9e75". */
  chartColor: string;
  /** Text size in the 72x72 SVG coordinate space. */
  textSize: number;
  /** Key background color. */
  bgColor: string;
  /** Optional custom label text drawn in smaller text under the value (empty = hidden). */
  label: string;
  /** Vertical position of the value (the label follows directly underneath). */
  valuePosition: "top" | "center" | "bottom";
  /** Display unit for memory sensors reported in MB: keep MB, or convert to GB (1 decimal). */
  memoryUnit: "MB" | "GB";
  /** Chart mode: when true the Y axis auto-scales to the data (default). */
  chartAuto: boolean;
  /** Chart mode: fixed Y-axis minimum when `chartAuto` is false. */
  chartMin: number;
  /** Chart mode: fixed Y-axis maximum when `chartAuto` is false. */
  chartMax: number;
}

export const DEFAULTS: ActionSettings = {
  parameterName: "",
  displayMode: "text",
  textColor: "#ffffff",
  chartColor: "#1d9e75",
  textSize: 24,
  bgColor: "#000000",
  label: "",
  valuePosition: "center",
  memoryUnit: "MB",
  chartAuto: true,
  chartMin: 0,
  chartMax: 100,
};

/** Merge stored (possibly partial) settings over the defaults. */
export function withDefaults(stored?: Partial<ActionSettings>): ActionSettings {
  return { ...DEFAULTS, ...(stored ?? {}) };
}

/** Number of samples kept per key for the chart mode. */
export const HISTORY_MAX = 50;
