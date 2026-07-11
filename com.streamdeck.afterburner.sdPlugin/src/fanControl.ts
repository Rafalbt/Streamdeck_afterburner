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
  ClientFanCoolersGetStatus: 0x35aed5e8,
} as const;

// NV_GPU_CLIENT_FAN_COOLERS_STATUS_V1 (reverse-engineered layout):
//   u32 version; u32 count; u32 reserved[8];                    -> 40-byte header
//   entry { u32 coolerId, currentRpm, currentMinLevel,
//           currentMaxLevel, currentLevel; u32 reserved[8]; }   -> 52 bytes, x32
const FAN_STATUS_SIZE = 40 + 32 * 52; // 1704
const FAN_STATUS_VERSION = (FAN_STATUS_SIZE | (1 << 16)) >>> 0;

let nvReady: boolean | undefined;
let nvGpu0: unknown = null;
let nvGetStatus: ((gpu: unknown, statusBuf: Buffer) => number) | null = null;

function initNvapi(): boolean {
  if (nvReady !== undefined) return nvReady;
  nvReady = false;
  try {
    const lib = koffi.load("nvapi64.dll");
    const queryInterface = lib.func("void* nvapi_QueryInterface(uint32)");
    const resolve = (id: number, proto: string): (...a: unknown[]) => number => {
      const p = queryInterface(id);
      if (!p) throw new Error(`QueryInterface 0x${id.toString(16)} returned null`);
      // koffi turns a function-pointer into a callable via decode(ptr, proto)
      // — NOT wrapped in koffi.pointer() (that yields a non-callable object).
      return koffi.decode(p, koffi.proto(proto)) as (...a: unknown[]) => number;
    };

    const initialize = resolve(NVID.Initialize, "int NvAPI_Initialize()");
    const enumGpus = resolve(NVID.EnumPhysicalGPUs, "int NvAPI_EnumPhysicalGPUs(void* handles, void* count)");
    const getStatus = resolve(
      NVID.ClientFanCoolersGetStatus,
      "int NvAPI_GPU_ClientFanCoolersGetStatus(void* gpu, void* status)",
    );

    let st = initialize();
    if (st !== 0) throw new Error(`NvAPI_Initialize status ${st}`);

    const handles = Buffer.alloc(8 * 64); // NvPhysicalGpuHandle[NVAPI_MAX_PHYSICAL_GPUS]
    const count = Buffer.alloc(4);
    st = enumGpus(handles, count);
    const n = count.readUInt32LE(0);
    if (st !== 0 || n === 0) throw new Error(`NvAPI_EnumPhysicalGPUs status ${st}, count ${n}`);

    nvGpu0 = koffi.decode(handles, "void *"); // first GPU handle
    nvGetStatus = getStatus as unknown as (gpu: unknown, statusBuf: Buffer) => number;
    nvReady = true;
    log.info(`[fan] NVAPI initialized (${n} GPU[s])`);
  } catch (e) {
    log.error("[fan] NVAPI init failed:", e);
  }
  return nvReady;
}

/** Read cooler 0 status (rpm + duty %) via the client fan coolers API. */
function readFanStatus(): { rpm: number; level: number } | null {
  if (detectVendor() !== "nvidia" || !initNvapi() || !nvGetStatus || !nvGpu0) return null;
  try {
    const buf = Buffer.alloc(FAN_STATUS_SIZE);
    buf.writeUInt32LE(FAN_STATUS_VERSION, 0);
    const st = nvGetStatus(nvGpu0, buf);
    if (st !== 0) {
      log.error(`[fan] ClientFanCoolersGetStatus status ${st} (ver=0x${FAN_STATUS_VERSION.toString(16)}, size=${FAN_STATUS_SIZE})`);
      return null;
    }
    const count = buf.readUInt32LE(4);
    const base = 40; // first entry
    const rpm = buf.readUInt32LE(base + 4);
    const level = buf.readUInt32LE(base + 16);
    log.info(`[fan] status ok: coolers=${count} rpm=${rpm} level=${level}%`);
    return { rpm, level };
  } catch (e) {
    log.error("[fan] ClientFanCoolersGetStatus error:", e);
    return null;
  }
}

/** Current fan speed in RPM via NVAPI, or null when unavailable. */
export function readFanRpm(): number | null {
  return readFanStatus()?.rpm ?? null;
}

/** Current fan duty as a percentage (0-100), or null when unknown. */
export function readFanPercent(): number | null {
  return readFanStatus()?.level ?? null;
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
