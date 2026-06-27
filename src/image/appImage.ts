// ESP-IDF application-image loader (M2.0). The compile service emits `sketch.ino.bin`
// — an ESP-IDF app image: a 24-byte header (magic 0xE9, segment count, entry address)
// followed by N segments, each `[load_addr:u32][length:u32][data]`. Every segment
// already carries its FINAL virtual load address (IRAM/DRAM and the flash-mapped
// DROM/IROM windows), so we statically place each segment and jump to the entry —
// pre-resolving the flash-cache MMU instead of emulating it (ADR-003 extended; see
// docs/adr/ADR-005). Verified against a real esptool image_info dump (docs/notes/esp32-image.md).

import { SystemBus } from "../memory";

/** ESP32 internal-SRAM + RTC regions, pre-declared so .bss/heap/stack (which are NOT
 *  in the image — startup zero-fills them) have backing memory. The flash-mapped
 *  DROM/IROM segments get regions sized to the segment at load time (ensureRegion). */
export const ESP32_RAM_REGIONS: ReadonlyArray<{ name: string; base: number; size: number }> = [
  { name: "DRAM", base: 0x3ffae000, size: 0x52000 }, // data SRAM → .data/.bss/heap/stack
  { name: "IRAM", base: 0x40080000, size: 0x20000 }, // instruction SRAM → IRAM code/data
  { name: "RTC_FAST_D", base: 0x3ff80000, size: 0x2000 },
  { name: "RTC_FAST_I", base: 0x400c0000, size: 0x2000 },
  { name: "RTC_SLOW", base: 0x50000000, size: 0x2000 },
];

/** Initial stack pointer: top of DRAM, 16-byte aligned. Startup sets its own SP early,
 *  but a sane a1 avoids a fault if anything pushes before that. */
export const ESP32_STACK_TOP = 0x3ffffff0;

const APP_IMAGE_MAGIC = 0xe9;
const HEADER_LEN = 24; // 8-byte basic header + 16-byte extended header
const SEG_ALIGN = 0x10000; // 64 KB — round flash-region bounds to MMU page size

export interface AppSegment {
  loadAddr: number;
  data: Uint8Array;
  /** Byte offset of this segment's data within the app image (its flash position). */
  fileOffset: number;
}

// DROM (flash-mapped constant data) virtual window on the classic ESP32.
const DROM_LOW = 0x3f400000;
const DROM_HIGH = 0x3f800000;

export interface AppImage {
  entry: number;
  segments: AppSegment[];
  segmentCount: number;
}

/** Parse an ESP-IDF app image into its entry point + segments. Does not touch memory. */
export function parseAppImage(bytes: Uint8Array): AppImage {
  if (bytes.length < HEADER_LEN || bytes[0] !== APP_IMAGE_MAGIC) {
    throw new Error(
      `invalid ESP32 app image: magic 0x${(bytes[0] ?? 0).toString(16)} (expected 0xe9)`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segmentCount = bytes[1];
  const entry = dv.getUint32(4, true) >>> 0;

  const segments: AppSegment[] = [];
  let off = HEADER_LEN;
  for (let i = 0; i < segmentCount; i++) {
    if (off + 8 > bytes.length) throw new Error(`truncated app image: segment ${i} header past EOF`);
    const loadAddr = dv.getUint32(off, true) >>> 0;
    const length = dv.getUint32(off + 4, true) >>> 0;
    off += 8;
    if (off + length > bytes.length) throw new Error(`truncated app image: segment ${i} data past EOF`);
    segments.push({ loadAddr, data: bytes.subarray(off, off + length), fileOffset: off });
    off += length;
  }
  return { entry, segments, segmentCount };
}

/** Ensure a RAM region covers [base, base+len); add a 64 KB-aligned one if not (the
 *  flash-mapped DROM/IROM segments, which fall outside the pre-declared internal SRAM). */
function ensureRegion(bus: SystemBus, base: number, len: number): void {
  if (bus.hasRegion(base, len)) return;
  const lo = base & ~(SEG_ALIGN - 1);
  const hi = (base + len + (SEG_ALIGN - 1)) & ~(SEG_ALIGN - 1);
  bus.addRegion(lo, hi - lo);
}

/** Build a SystemBus with the ESP32 memory map, load every segment to its virtual
 *  address, and report the entry point + initial stack pointer. Devices (GPIO/UART/…)
 *  are added by the caller afterward. */
export function loadAppImage(bytes: Uint8Array): { bus: SystemBus; entry: number; sp: number } {
  const img = parseAppImage(bytes);
  const bus = new SystemBus(0, 0); // start empty; regions added explicitly
  for (const r of ESP32_RAM_REGIONS) bus.addRegion(r.base, r.size);

  // Map the raw image into the DROM (flash-mapped) window, exactly as the cache makes the
  // app's own flash visible to it: image byte `fileOffset` appears at `dromBase+fileOffset`.
  // The IDF runtime (map_rom_segments in cpu_start) reads its image header + segment table
  // back through this window to set up the cache MMU; without it boot aborts with
  // "Invalid app image header". We don't model the MMU (ADR-005) — we just expose the
  // flash bytes where they're mapped. Segment loads below run AFTER and win on overlap.
  const drom = img.segments.find((s) => s.loadAddr >= DROM_LOW && s.loadAddr < DROM_HIGH);
  if (drom) {
    const dromBase = (drom.loadAddr - drom.fileOffset) >>> 0;
    ensureRegion(bus, dromBase, bytes.length);
    for (let i = 0; i < bytes.length; i++) bus.write8((dromBase + i) >>> 0, bytes[i]);
  }

  for (const seg of img.segments) {
    ensureRegion(bus, seg.loadAddr, seg.data.length);
    for (let i = 0; i < seg.data.length; i++) bus.write8((seg.loadAddr + i) >>> 0, seg.data[i]);
  }
  return { bus, entry: img.entry, sp: ESP32_STACK_TOP };
}
