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
import streamDeck from "@elgato/streamdeck";

const log = streamDeck.logger;

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

// ---- NVIDIA / NVAPI (Phase 2a: read-only) ----------------------------------
//
// nvapi64.dll exports only `nvapi_QueryInterface(id)`, returning a function
// pointer for the given (undocumented) function ID. We resolve the few we need,
// then call them. Pointer/out args are passed as Node Buffers for predictable
// marshalling. Status 0 == NVAPI_OK.

const NVID = {
  Initialize: 0x0150e828,
  EnumPhysicalGPUs: 0xe5ac921f,
  GetTachReading: 0x5f608315,
} as const;

let nvReady: boolean | undefined;
let nvGpu0: unknown = null;
let nvGetTach: ((gpu: unknown, rpmBuf: Buffer) => number) | null = null;

function initNvapi(): boolean {
  if (nvReady !== undefined) return nvReady;
  nvReady = false;
  try {
    const lib = koffi.load("nvapi64.dll");
    const queryInterface = lib.func("void* nvapi_QueryInterface(uint32)");
    const resolve = (id: number, proto: string): (...a: unknown[]) => number => {
      const p = queryInterface(id);
      if (!p) throw new Error(`QueryInterface 0x${id.toString(16)} returned null`);
      return koffi.decode(p, koffi.pointer(koffi.proto(proto))) as (...a: unknown[]) => number;
    };

    const initialize = resolve(NVID.Initialize, "int NvAPI_Initialize()");
    const enumGpus = resolve(NVID.EnumPhysicalGPUs, "int NvAPI_EnumPhysicalGPUs(void* handles, void* count)");
    const getTach = resolve(NVID.GetTachReading, "int NvAPI_GPU_GetTachReading(void* gpu, void* rpm)");

    let st = initialize();
    if (st !== 0) throw new Error(`NvAPI_Initialize status ${st}`);

    const handles = Buffer.alloc(8 * 64); // NvPhysicalGpuHandle[NVAPI_MAX_PHYSICAL_GPUS]
    const count = Buffer.alloc(4);
    st = enumGpus(handles, count);
    const n = count.readUInt32LE(0);
    if (st !== 0 || n === 0) throw new Error(`NvAPI_EnumPhysicalGPUs status ${st}, count ${n}`);

    nvGpu0 = koffi.decode(handles, "void *"); // first GPU handle
    nvGetTach = getTach as unknown as (gpu: unknown, rpmBuf: Buffer) => number;
    nvReady = true;
    log.info(`[fan] NVAPI initialized (${n} GPU[s])`);
  } catch (e) {
    log.error("[fan] NVAPI init failed:", e);
  }
  return nvReady;
}

/** Current fan speed in RPM via NVAPI, or null when unavailable. */
export function readFanRpm(): number | null {
  if (detectVendor() !== "nvidia" || !initNvapi() || !nvGetTach || !nvGpu0) return null;
  try {
    const rpm = Buffer.alloc(4);
    const st = nvGetTach(nvGpu0, rpm);
    if (st !== 0) {
      log.error(`[fan] GetTachReading status ${st}`);
      return null;
    }
    return rpm.readUInt32LE(0);
  } catch (e) {
    log.error("[fan] GetTachReading error:", e);
    return null;
  }
}

/**
 * Read the current fan duty as a percentage (0-100), or null when unknown.
 * PHASE 2b/3 will read the duty via NVAPI cooler settings / ADL.
 */
export function readFanPercent(): number | null {
  return null;
}

/**
 * Request a fan duty percentage (0-100). Returns true if applied.
 * PHASE 1 stub — logs and returns false (no hardware write yet).
 */
export function setFanPercent(pct: number): boolean {
  log.info(`[fan] setFanPercent(${pct}) — not yet implemented (${detectVendor()})`);
  return false;
}

/**
 * Restore automatic (driver/Afterburner) fan control.
 * PHASE 1 stub — logs and returns false.
 */
export function restoreAuto(): boolean {
  log.info(`[fan] restoreAuto() — not yet implemented (${detectVendor()})`);
  return false;
}
