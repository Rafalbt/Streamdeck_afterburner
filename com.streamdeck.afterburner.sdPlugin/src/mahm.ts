/**
 * Reader for MSI Afterburner's "MAHMSharedMemory" shared memory segment.
 *
 * The layout is documented in the MSI Afterburner "Remote Server" SDK
 * (MAHMSharedMemory.h). We only rely on the fields whose offsets are stable in
 * the v2.x memory format:
 *
 *   Header:
 *     0  DWORD dwSignature   'MAHM' (0x4D41484D) once data is ready
 *     4  DWORD dwVersion
 *     8  DWORD dwHeaderSize  -> byte offset of the first entry
 *    12  DWORD dwNumEntries
 *    16  DWORD dwEntrySize   -> stride between entries
 *
 *   Entry (MAHM_SHARED_MEMORY_ENTRY):
 *     0     char  szSrcName[260]            sensor name, e.g. "GPU temperature"
 *     260   char  szSrcUnits[260]           unit, e.g. "°C"
 *     ...   (three more char[260] fields)
 *     1300  float data                      current value
 *
 * We resolve entry positions dynamically via dwHeaderSize/dwEntrySize, so minor
 * struct-size changes between Afterburner versions stay safe. Reads never mutate
 * the segment, so a single handle can be shared across all key instances.
 */
import koffi from "koffi";

const SHM_NAME = "MAHMSharedMemory";
const FILE_MAP_READ = 0x0004;
const MAHM_SIGNATURE = 0x4d41484d; // 'MAHM' little-endian

const STR_LEN = 260; // MAX_PATH — length of each char[] field
const OFF_SRC_NAME = 0;
const OFF_SRC_UNITS = STR_LEN; // 260
const OFF_DATA = STR_LEN * 5; // 1300: five char[260] fields precede `data`
const HEADER_PROBE = 20; // bytes needed to read the five header DWORDs

const kernel32 = koffi.load("kernel32.dll");
const OpenFileMappingA = kernel32.func("OpenFileMappingA", "void *", ["uint32", "bool", "str"]);
const MapViewOfFile = kernel32.func("MapViewOfFile", "void *", ["void *", "uint32", "uint32", "uint32", "size_t"]);
const UnmapViewOfFile = kernel32.func("UnmapViewOfFile", "bool", ["void *"]);
const CloseHandle = kernel32.func("CloseHandle", "bool", ["void *"]);

const U8_ARRAY = (n: number) => koffi.array("uint8", n, "Typed");

export interface SensorEntry {
  name: string;
  unit: string;
  value: number;
}

// HANDLE returned by OpenFileMappingA. koffi yields null for a NULL pointer.
let hMapping: unknown = null;
let refCount = 0;

/** Read a NUL-terminated latin1 string from `buf` at [offset, offset+maxLen). */
function readCStr(buf: Uint8Array, offset: number, maxLen: number): string {
  const limit = Math.min(offset + maxLen, buf.length);
  let end = offset;
  while (end < limit && buf[end] !== 0) end++;
  // Afterburner writes ANSI (CP-1252); latin1 covers the symbols we care about
  // (e.g. "°C") for the Western European range without extra dependencies.
  return Buffer.from(buf.buffer, buf.byteOffset + offset, end - offset).toString("latin1").trim();
}

/** Ensure the shared-memory handle is open. Returns false if it cannot be opened. */
function ensureOpen(): boolean {
  if (hMapping) return true;
  const handle = OpenFileMappingA(FILE_MAP_READ, false, SHM_NAME);
  if (!handle) return false; // Afterburner not running / hardware monitoring off
  hMapping = handle;
  return true;
}

/**
 * Read the current sensor snapshot.
 * @returns the list of sensors, or `null` when Afterburner is unavailable or its
 *          data is not yet ready (signature mismatch).
 */
export function readMahm(): SensorEntry[] | null {
  if (!ensureOpen()) return null;

  const view = MapViewOfFile(hMapping, FILE_MAP_READ, 0, 0, 0);
  if (!view) return null;

  try {
    const head = koffi.decode(view, 0, U8_ARRAY(HEADER_PROBE)) as Uint8Array;
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (hv.getUint32(0, true) !== MAHM_SIGNATURE) return null; // data not ready yet

    const headerSize = hv.getUint32(8, true);
    const numEntries = hv.getUint32(12, true);
    const entrySize = hv.getUint32(16, true);
    if (numEntries === 0 || entrySize === 0) return [];

    const total = headerSize + numEntries * entrySize;
    const buf = koffi.decode(view, 0, U8_ARRAY(total)) as Uint8Array;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const out: SensorEntry[] = [];
    for (let i = 0; i < numEntries; i++) {
      const base = headerSize + i * entrySize;
      out.push({
        name: readCStr(buf, base + OFF_SRC_NAME, STR_LEN),
        unit: readCStr(buf, base + OFF_SRC_UNITS, STR_LEN),
        value: dv.getFloat32(base + OFF_DATA, true),
      });
    }
    return out;
  } finally {
    UnmapViewOfFile(view);
  }
}

/** Find a sensor by its exact MAHM name. */
export function findEntry(entries: SensorEntry[], name: string): SensorEntry | undefined {
  return entries.find((e) => e.name === name);
}

/** Register an active consumer of the shared memory. */
export function acquire(): void {
  refCount++;
}

/** Release a consumer; closes the handle once the last one is gone. */
export function release(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) closeMahm();
}

/** Close and forget the shared-memory handle. */
export function closeMahm(): void {
  if (hMapping) {
    CloseHandle(hMapping);
    hMapping = null;
  }
}
