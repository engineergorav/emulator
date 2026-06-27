// M2.2 windowed register spill/fill smoke test. Runs a REAL toolchain-assembled program
// that recurses sum(12) = 12+11+...+0 via call8 — 12 frames deep, past the 8 the 64-
// register window holds — so the descent forces WindowOverflow spills and the unwind
// forces WindowUnderflow fills. The program installs the standard Xtensa
// _WindowOverflow8/_WindowUnderflow8 handler code at VECBASE (via wsr.vecbase); the core
// vectors to them, they do the real s32e/l32e moves + rfwo/rfwu, and execution resumes.
// If spill/fill is correct the result is 78; any bug corrupts a frame and the result is
// wrong or it faults. Deterministic + toolchain-free at run time (bytes are embedded).
//
// Run: node lib/esp-core/test/esp32-window-smoke.mjs
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
const tmp = "D:/Routing-Engine/lib/esp-core/test/_win_bundle.mjs";
writeFileSync(tmp, res.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
const { SystemBus, XtensaLX6Core } = mod;

// Flat image: _WindowOverflow8 @ +0x80, _WindowUnderflow8 @ +0xC0, vbase word @ +0x1F8,
// _start @ +0x200 (sets VECBASE then call8 sum(12)), `end` self-loop @ +0x210, sum @ +0x214.
// Assembled with xtensa-esp32-elf-gcc; vbase word holds 0x40090000 = the load BASE below.
const BASE = 0x40090000;
const IMG = new Uint8Array(550);
const put = (off, bytes) => bytes.forEach((b, i) => (IMG[off + i] = b));
// _WindowOverflow8 (s32e a0,a9,-16; l32e a0,a1,-12; s32e a1/a2/a3,a9; s32e a4-a7,a0; rfwo)
put(0x80, [0,201,73, 0,209,9, 16,217,73, 32,233,73, 48,249,73, 64,128,73, 80,144,73, 96,160,73, 112,176,73, 0,52,0]);
// _WindowUnderflow8 (l32e a0/a1/a2,a9; l32e a7,a1,-12; l32e a3,a9; l32e a4-a7,a7; rfwu)
put(0xc0, [0,201,9, 16,217,9, 32,233,9, 112,209,9, 48,249,9, 64,135,9, 80,151,9, 96,167,9, 112,183,9, 0,53,0]);
put(0x1f8, [0x00, 0x00, 0x09, 0x40]); // vbase = 0x40090000 (LE)
// _start: l32r a8,vbase; wsr.vecbase a8; rsync; movi.n a10,12; call8 sum; mov.n a3,a10; j .
// (call8 passes the argument in a10 → the callee sees it as a2.)
put(0x200, [129,254,255, 128,231,19, 16,32,0, 12,202, 165,0,0, 61,10, 6,255,255]);
// sum: entry a1,32; bnez.n a2,recurse; movi.n a2,0; retw.n; addi.n a10,a2,-1; call8 sum; add.n a2,a2,a10; retw.n
put(0x214, [54,65,0, 204,34, 12,2, 29,240, 11,162, 101,255,255, 170,34, 29,240]);

const bus = new SystemBus(BASE, 0x8000); // flat RAM: code low, stack high
for (let i = 0; i < IMG.length; i++) bus.write8(BASE + i, IMG[i]);

const core = new XtensaLX6Core(bus);
core.reset();
core.pc = BASE + 0x200;        // _start
const sp = (BASE + 0x4000) >>> 0;
core.writeReg(1, sp);          // root (_start) stack pointer
// Root frame base save area (the bootloader's job): when the root is spilled, the handler
// reads [root_sp-12] as the caller SP and saves a4-a7 into that caller frame. Point it
// above root_sp at valid RAM (a4-a7 land there; never read back — root never returns).
bus.write32((sp - 12) >>> 0, (sp + 0x40) >>> 0);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if ((got | 0) === (want | 0)) pass++;
  else { fail++; console.log(`  ✗ ${name}: got ${got | 0}, want ${want | 0}`); };
};

let stop = null;
const END = (BASE + 0x210) >>> 0;
let i = 0;
for (; i < 200000; i++) {
  if ((core.pc >>> 0) === END) break;     // reached the `j .` park
  try { core.step(); } catch (e) { stop = e; break; }
}
eq("ran without fault", stop === null ? 1 : 0, 1);
if (stop) console.log(`  (stopped: ${stop.message} @ pc=0x${(core.pc >>> 0).toString(16)})`);
eq("reached end park", (core.pc >>> 0) === END ? 1 : 0, 1);
// a3 = sum(12) = 12*13/2 = 78. Window is back at the root, so a3 == AR[3].
eq("sum(12) via spill/fill = 78", core.readReg(3), 78);

console.log("");
console.log(fail === 0
  ? `ESP32 WINDOW SMOKE PASS ✓  (${pass} assertions — call8 recursion overflows + unwinds via spill/fill)`
  : `ESP32 WINDOW SMOKE FAIL ✗  (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
