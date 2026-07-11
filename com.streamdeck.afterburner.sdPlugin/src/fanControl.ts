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
  ClientFanCoolersGetControl: 0x814b209f,
  ClientFanCoolersSetControl: 0xa58971a5,
} as const;

// NV_GPU_CLIENT_FAN_COOLERS_CONTROL_V1 — exact size is reverse-engineered and
// varies; we probe candidate sizes/versions once (read-only) and cache the one
// the driver accepts. Header assumed 40 bytes (u32 version, count, reserved[8]).
// Resolved layout (RTX 5080 / current driver): 44-byte header, 44-byte entries.
//   header: u32 version, u32 _, u32 count (@8), u32 reserved[8]
//   entry i @ (44 + i*44): u32 coolerId(+0), u32 level(+4), u32 controlMode(+8)
const CTRL_VER_CANDIDATES = [1, 2, 3];
const CTRL_COUNT_OFF = 8;
const CTRL_HEADER_BYTES = 44;
const CTRL_ENTRY_BYTES = 44;
const CTRL_LEVEL_OFF = 4;
const CTRL_MODE_OFF = 8;
const CTRL_MODE_AUTO = 0;
const CTRL_MODE_MANUAL = 1;

/** Never command a duty below this, to avoid overheating. */
const FAN_MIN_PCT = 30;

let ctrlSize = 0; // resolved by probeControl()
let ctrlVersion = 0;

// NV_GPU_CLIENT_FAN_COOLERS_STATUS_V1 (reverse-engineered layout):
//   u32 version; u32 count; u32 reserved[8];                    -> 40-byte header
//   entry { u32 coolerId, currentRpm, currentMinLevel,
//           currentMaxLevel, currentLevel; u32 reserved[8]; }   -> 52 bytes, x32
const FAN_STATUS_SIZE = 40 + 32 * 52; // 1704
const FAN_STATUS_VERSION = (FAN_STATUS_SIZE | (1 << 16)) >>> 0;

let nvReady: boolean | undefined;
let nvGpu0: unknown = null;
let nvGetStatus: ((gpu: unknown, statusBuf: Buffer) => number) | null = null;
let nvGetControl: ((gpu: unknown, ctrlBuf: Buffer) => number) | null = null;
let nvSetControl: ((gpu: unknown, ctrlBuf: Buffer) => number) | null = null;

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
    const getControl = resolve(
      NVID.ClientFanCoolersGetControl,
      "int NvAPI_GPU_ClientFanCoolersGetControl(void* gpu, void* control)",
    );
    const setControl = resolve(
      NVID.ClientFanCoolersSetControl,
      "int NvAPI_GPU_ClientFanCoolersSetControl(void* gpu, void* control)",
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
    nvGetControl = getControl as unknown as (gpu: unknown, ctrlBuf: Buffer) => number;
    nvSetControl = setControl as unknown as (gpu: unknown, ctrlBuf: Buffer) => number;
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

/** Brute-force the control-struct size/version once by sweeping sizes (read-only). */
function probeControl(): boolean {
  if (ctrlSize) return true;
  if (!nvGetControl || !nvGpu0) return false;
  const notable: string[] = [];
  for (let size = 8; size <= 8192; size += 4) {
    for (const ver of CTRL_VER_CANDIDATES) {
      const version = (size | (ver << 16)) >>> 0;
      const buf = Buffer.alloc(size);
      buf.writeUInt32LE(version, 0);
      const st = nvGetControl(nvGpu0, buf);
      if (st !== -9) notable.push(`size=${size} ver=${ver} -> ${st}`); // -9 = wrong version
      if (st === 0) {
        ctrlSize = size;
        ctrlVersion = version;
        log.info(`[fan] CONTROL struct resolved: size=${size} ver=${ver}`);
        log.info(`[fan] probe notable: ${notable.join(" | ")}`);
        return true;
      }
    }
  }
  log.error(`[fan] probeControl sweep: nothing returned 0. notable(non -9): ${notable.join(" | ") || "none"}`);
  return false;
}

/**
 * Request a fan duty percentage (0-100). Returns true if applied.
 * PHASE 2b (probe): resolves the control-struct layout via GetControl only
 * (read-only) and logs the intended change; SetControl write is enabled once
 * the layout is known and the safety floor is in place.
 */
/** Apply a control mode to every cooler: manual at `level%`, or restore auto. */
function applyControl(mode: number, level: number): boolean {
  if (detectVendor() !== "nvidia" || !initNvapi() || !nvGetControl || !nvSetControl || !nvGpu0) return false;
  if (!probeControl()) return false;
  const buf = Buffer.alloc(ctrlSize);
  buf.writeUInt32LE(ctrlVersion, 0);
  let st = nvGetControl(nvGpu0, buf);
  if (st !== 0) {
    log.error(`[fan] GetControl status ${st}`);
    return false;
  }
  const count = buf.readUInt32LE(CTRL_COUNT_OFF);
  for (let i = 0; i < count && i < 32; i++) {
    const base = CTRL_HEADER_BYTES + i * CTRL_ENTRY_BYTES;
    buf.writeUInt32LE(mode, base + CTRL_MODE_OFF);
    if (mode === CTRL_MODE_MANUAL) buf.writeUInt32LE(level, base + CTRL_LEVEL_OFF);
  }
  st = nvSetControl(nvGpu0, buf);
  if (st !== 0) {
    log.error(`[fan] SetControl status ${st}`);
    return false;
  }
  log.info(`[fan] SetControl ok: ${count} cooler(s) mode=${mode} level=${mode === CTRL_MODE_MANUAL ? level + "%" : "auto"}`);
  return true;
}

/**
 * Request a fan duty percentage. Clamped to [FAN_MIN_PCT, 100] for safety.
 * Sets every cooler to manual at that duty.
 */
export function setFanPercent(pct: number): boolean {
  const level = Math.max(FAN_MIN_PCT, Math.min(100, Math.round(pct)));
  return applyControl(CTRL_MODE_MANUAL, level);
}

/** Restore automatic fan control for every cooler. */
export function restoreAuto(): boolean {
  return applyControl(CTRL_MODE_AUTO, 0);
}
