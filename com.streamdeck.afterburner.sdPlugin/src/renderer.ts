/**
 * SVG renderers for key images. Stream Deck's setImage accepts SVG directly, so
 * we build plain template strings — no canvas / native graphics dependency.
 * Everything is drawn in a 72x72 coordinate space and scales to any key size.
 */
import type { ActionSettings } from "./settings.js";

const W = 72;
const H = 72;

/** Escape the five XML-significant characters for safe embedding in SVG text. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Format a value into a compact display string. GB/GHz keep fixed decimals. */
export function formatValue(v: number, unit?: string): string {
  if (!Number.isFinite(v)) return "--";
  if (unit === "GB") return v.toFixed(1);
  if (unit === "GHz") return v.toFixed(2);
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v).toString();
  if (abs >= 100) return v.toFixed(0);
  return (Math.round(v * 10) / 10).toString();
}

/** Apply unit preferences: MB->GB (÷1024) and MHz->GHz (÷1000) when requested. */
export function convertUnit(
  value: number,
  unit: string,
  s: Pick<ActionSettings, "memoryUnit" | "frequencyUnit">,
): { value: number; unit: string } {
  if (unit === "MB" && s.memoryUnit === "GB") {
    return { value: value / 1024, unit: "GB" };
  }
  if (unit === "MHz" && s.frequencyUnit === "GHz") {
    return { value: value / 1000, unit: "GHz" };
  }
  return { value, unit };
}

function frame(inner: string, bg: string): string {
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="${bg}"/>${inner}</svg>`;
}

/** Vertical anchor (dominant-baseline central) for a value position, in 72-space. */
function valueY(pos: ActionSettings["valuePosition"]): number {
  return pos === "top" ? 24 : pos === "bottom" ? 46 : 36;
}

/** A smaller, dimmed label drawn directly under the value (empty string when no text). */
function labelUnder(text: string, valueYPos: number, valueFont: number, color: string): string {
  if (!text) return "";
  const size = Math.max(8, Math.min(12, Math.round(valueFont * 0.5)));
  const y = Math.min(H - 3, valueYPos + valueFont / 2 + size / 2 + 2);
  return `<text x="36" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" fill="${color}" font-family="sans-serif" font-size="${size}" opacity="0.75">${esc(text)}</text>`;
}

/** Current value (with unit) at the configured position, with the label underneath. */
export function renderText(value: string, unit: string, s: ActionSettings): string {
  const vy = valueY(s.valuePosition);
  const unitTspan = unit
    ? `<tspan font-size="${Math.max(8, Math.round(s.textSize * 0.55))}"> ${esc(unit)}</tspan>`
    : "";
  const valueSvg =
    `<text x="36" y="${vy}" text-anchor="middle" dominant-baseline="central" ` +
    `fill="${s.textColor}" font-family="sans-serif" font-weight="bold" font-size="${s.textSize}">${esc(value)}${unitTspan}</text>`;
  const inner = valueSvg + labelUnder(s.label, vy, s.textSize, s.textColor);
  return frame(inner, s.bgColor);
}

/**
 * Mini line chart of recent history. The line always occupies the same fixed
 * area (independent of `valuePosition`); the current value and its label are
 * drawn on top per `valuePosition`. Falls back to text rendering with too few
 * samples to draw a line.
 */
export function renderChart(history: number[], unit: string, s: ActionSettings): string {
  if (history.length < 2) {
    return renderText(formatValue(history[history.length - 1] ?? NaN, unit), unit, s);
  }

  // Fixed plot area — moving the value text must not shift the chart line.
  const pad = 6;
  const plotTop = pad;
  const plotH = H - 2 * pad;

  // Fixed thresholds when configured, otherwise auto-scale to the data.
  let min: number;
  let max: number;
  if (s.chartAuto) {
    min = Math.min(...history);
    max = Math.max(...history);
  } else {
    min = Math.min(s.chartMin, s.chartMax);
    max = Math.max(s.chartMin, s.chartMax);
  }
  const range = max - min || 1;
  const span = history.length - 1;
  const plotBottom = plotTop + plotH;

  const coords = history.map((v, i) => {
    const clamped = Math.min(max, Math.max(min, v)); // keep out-of-range values in view
    const x = pad + (i / span) * (W - 2 * pad);
    const y = plotTop + (1 - (clamped - min) / range) * plotH;
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Filled area from the line down to the plot bottom, painted with a vertical
  // gradient that is full color at the top of the plot and fades out downward.
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `${line} ${last[0].toFixed(1)},${plotBottom} ${first[0].toFixed(1)},${plotBottom}`;
  const gradient =
    `<defs><linearGradient id="fill" x1="0" y1="${plotTop}" x2="0" y2="${plotBottom}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${s.chartColor}" stop-opacity="1"/>` +
    `<stop offset="1" stop-color="${s.chartColor}" stop-opacity="0"/>` +
    `</linearGradient></defs>`;

  const current = formatValue(history[history.length - 1], unit);
  const valueLabel = unit ? `${current}${unit}` : current;
  const vy = valueY(s.valuePosition);
  const inner =
    gradient +
    `<polygon points="${area}" fill="url(#fill)" stroke="none"/>` +
    `<polyline points="${line}" fill="none" stroke="${s.chartColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<text x="36" y="${vy}" text-anchor="middle" dominant-baseline="central" fill="${s.textColor}" font-family="sans-serif" font-weight="bold" font-size="14">${esc(valueLabel)}</text>` +
    labelUnder(s.label, vy, 14, s.textColor);
  return frame(inner, s.bgColor);
}

/** Centered status message (e.g. "N/A") used for error / unavailable states. */
export function renderMessage(msg: string, s: ActionSettings): string {
  const inner = `<text x="36" y="36" text-anchor="middle" dominant-baseline="central" fill="#ff5555" font-family="sans-serif" font-weight="bold" font-size="18">${esc(msg)}</text>`;
  return frame(inner, s.bgColor);
}

/** Wrap an SVG string as a data URI accepted by action.setImage. */
export function toImage(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
