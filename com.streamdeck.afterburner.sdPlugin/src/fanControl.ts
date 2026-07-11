/**
 * Fan-control abstraction. Direct GPU fan control is vendor-specific:
 *   - NVIDIA -> NVAPI (nvapi64.dll)
 *   - AMD    -> ADL   (atiadlxx.dll)
 *
 * PHASE 1 (this file for now): only vendor DETECTION is implemented (loading the
 * vendor DLL, which is safe and side-effect free). Reading and setting the fan
 * are stubs — Phase 2 (NVAPI) and Phase 3 (ADL) will fill them in, and must be
 * validated on real hardware. Setting a fan speed too low can overheat the GPU,
 * so the caller is responsible for a floor and for restoring auto control.
 */
import koffi from "koffi";

export type Vendor = "nvidia" | "amd" | "none";

let cachedVendor: Vendor | undefined;

/** Detect the GPU vendor by which control library is present. Safe (load only). */
export function detectVendor(): Vendor {
  if (cachedVendor !== undefined) return cachedVendor;
  cachedVendor = "none";
  try {
    koffi.load("nvapi64.dll");
    cachedVendor = "nvidia";
  } catch {
    try {
      koffi.load("atiadlxx.dll");
      cachedVendor = "amd";
    } catch {
      // neither present
    }
  }
  return cachedVendor;
}

/**
 * Read the current fan duty as a percentage (0-100), or null when unknown.
 * PHASE 1 stub — returns null. Phases 2/3 will read via NVAPI / ADL.
 */
export function readFanPercent(): number | null {
  return null;
}

/**
 * Request a fan duty percentage (0-100). Returns true if applied.
 * PHASE 1 stub — logs and returns false (no hardware write yet).
 */
export function setFanPercent(pct: number): boolean {
  console.log(`[fan] setFanPercent(${pct}) — not yet implemented (${detectVendor()})`);
  return false;
}

/**
 * Restore automatic (driver/Afterburner) fan control.
 * PHASE 1 stub — logs and returns false.
 */
export function restoreAuto(): boolean {
  console.log(`[fan] restoreAuto() — not yet implemented (${detectVendor()})`);
  return false;
}
