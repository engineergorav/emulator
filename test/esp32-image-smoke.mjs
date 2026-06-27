// M2.0 app-image loader smoke test. Hand-crafts a minimal but REAL ESP-IDF app image
// (24-byte header + a DROM segment + an IRAM code segment of genuine Xtensa bytes),
// loads it through loadAppImage(), then runs the loaded code on the core. Asserts the
// segments landed at their virtual addresses, .bss-style DRAM beyond the image is
// backed, the entry is reachable, and execution produces the right register state.
// Deterministic + toolchain-free (the real-.bin boot reach is esp32-boot-probe.mjs).
//
// Run: node lib/esp-core/test/esp32-image-smoke.mjs
import { pathToFileURL } from "url";
import { writeFileSync, rmSync } from "fs";

const { build } = await import(
  pathToFileURL("D:/Routing-Engine/node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/lib/main.js").href
);
const res = await build({
  entryPoints: ["D:/Routing-Engine/lib/esp-core/src/index.ts"],
  bundle: true, format: "esm", platform: "node", write: false,
  loader: { ".ts": "ts" },
});
const tmp = "D:/Routing-Engine/lib/esp-core/test/_img_bundle.mjs";
writeFileSync(tmp, res.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
const { XtensaLX6Core, parseAppImage, loadAppImage } = mod;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = got | 0, w = want | 0;
  if (g === w) { pass++; }
  else { fail++; console.log(`  ✗ ${name}: got 0x${(g >>> 0).toString(16)}, want 0x${(w >>> 0).toString(16)}`); }
};

// ── Build a minimal app image ────────────────────────────────────────────────
function u32le(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

const ENTRY = 0x40080000;        // IRAM
const DROM = 0x3f400000;         // flash-mapped rodata (outside pre-declared SRAM)
const dromData = [0x11, 0x22, 0x33, 0x44];
// IRAM code: movi.n a2,5 ; movi.n a3,6 ; add.n a4,a2,a3 ; j .  (all M0-verified bytes)
const iramCode = [0x0c, 0x52, 0x0c, 0x63, 0x3a, 0x42, 0x06, 0xff, 0xff];

const image = Uint8Array.from([
  0xe9, 0x02, 0x02, 0x2f,        // magic, segCount=2, spi_mode, spi_speed
  ...u32le(ENTRY),               // entry
  ...new Array(16).fill(0),      // extended header (ignored by the loader)
  ...u32le(DROM), ...u32le(dromData.length), ...dromData,    // segment 1: DROM
  ...u32le(ENTRY), ...u32le(iramCode.length), ...iramCode,   // segment 2: IRAM code
  0x00,                          // trailing checksum byte (ignored)
]);

// ── parse ────────────────────────────────────────────────────────────────────
const parsed = parseAppImage(image);
eq("parsed entry", parsed.entry, ENTRY);
eq("parsed segment count", parsed.segmentCount, 2);
eq("parsed seg0 loadAddr", parsed.segments[0].loadAddr, DROM);
eq("parsed seg1 loadAddr", parsed.segments[1].loadAddr, ENTRY);

// ── load ─────────────────────────────────────────────────────────────────────
const { bus, entry, sp } = loadAppImage(image);
eq("loader entry", entry, ENTRY);
eq("DROM segment landed (auto-region)", bus.read32(DROM) >>> 0, 0x44332211); // LE of 11 22 33 44
eq("IRAM segment landed", bus.read32(ENTRY) >>> 0, 0x630c520c);             // LE of first 4 code bytes
// .bss/stack live in DRAM beyond the loaded segments — must be backed, not faulting:
bus.write32(0x3ffb0000, 0xdeadbeef | 0);
eq("DRAM beyond image is backed", bus.read32(0x3ffb0000) >>> 0, 0xdeadbeef);

// ── execute the loaded code ──────────────────────────────────────────────────
const core = new XtensaLX6Core(bus);
core.reset();
core.pc = entry;
core.writeReg(1, sp);
let stop = null;
for (let i = 0; i < 4; i++) {
  try { core.step(); }
  catch (e) { stop = e; break; }
}
eq("no fault running loaded code", stop === null ? 1 : 0, 1);
if (stop) console.log(`  (stopped: ${stop.message})`);
eq("a2 (movi.n 5)", core.readReg(2), 5);
eq("a3 (movi.n 6)", core.readReg(3), 6);
eq("a4 (add.n)", core.readReg(4), 11);
eq("pc parked at j-self", core.pc, ENTRY + 6);

console.log("");
console.log(fail === 0
  ? `ESP32 IMAGE SMOKE PASS ✓  (${pass} assertions — parse + load + execute)`
  : `ESP32 IMAGE SMOKE FAIL ✗  (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
