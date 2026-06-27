// M2.3 Timer Group (TIMERG0) RTC-calibration smoke test. Drives the calibration
// register block the way real ESP32 clock bring-up does — set CLK_SEL + MAX, arm START
// via a read-modify-write, poll RDY, read the count — and asserts the device behaves
// like the silicon counter (count XTAL cycles over MAX slow-clock cycles), with the
// right value for each slow-clock source. Deterministic + toolchain-free (the real-.bin
// boot reach through rtc_clk_cal_internal is esp32-boot-probe.mjs).
//
// Run: node lib/esp-core/test/esp32-timer-smoke.mjs
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
const tmp = "D:/Routing-Engine/lib/esp-core/test/_timer_bundle.mjs";
writeFileSync(tmp, res.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
const { SystemBus, TimerGroupDevice, TIMERG0_BASE, TIMERG1_BASE } = mod;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = got >>> 0, w = want >>> 0;
  if (g === w) { pass++; }
  else { fail++; console.log(`  ✗ ${name}: got 0x${g.toString(16)} (${g}), want 0x${w.toString(16)} (${w})`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}`); } };

const RTCCALICFG = TIMERG0_BASE + 0x68;
const RTCCALICFG1 = TIMERG0_BASE + 0x6c;
const CALI_START = 0x80000000;
const CALI_RDY = 1 << 15;
const cfgWord = (clkSel, max) => (((max & 0x7fff) << 16) | ((clkSel & 3) << 13)) >>> 0;

// Drive one calibration exactly as rtc_clk_cal_internal does, return the measured count.
function calibrate(bus, clkSel, max) {
  bus.write32(RTCCALICFG, cfgWord(clkSel, max));         // set CLK_SEL + MAX, START=0
  ok("RDY clear before START", (bus.read32(RTCCALICFG) & CALI_RDY) === 0);
  const armed = (bus.read32(RTCCALICFG) | CALI_START) >>> 0; // read-modify-write: arm START
  bus.write32(RTCCALICFG, armed);
  ok("RDY set after START", (bus.read32(RTCCALICFG) & CALI_RDY) !== 0);
  return (bus.read32(RTCCALICFG1) >>> 7) >>> 0;           // VALUE field = bits 31:7
}

const bus = new SystemBus(0, 0);
bus.addDevice(new TimerGroupDevice({ base: TIMERG0_BASE, xtalFreqHz: 40_000_000 }));

// ── RTC_MUX (CLK_SEL=0) → 150 kHz RC: count ≈ MAX * 40e6 / 150000 ────────────────
const MAX = 1024;
eq("RTC_MUX count (150 kHz)", calibrate(bus, 0, MAX), Math.round((MAX * 40_000_000) / 150_000));
// ── 8MD256 (CLK_SEL=1) → 31250 Hz ────────────────────────────────────────────────
eq("8MD256 count (31.25 kHz)", calibrate(bus, 1, MAX), Math.round((MAX * 40_000_000) / 31_250));
// ── 32K XTAL (CLK_SEL=2) → 32768 Hz ──────────────────────────────────────────────
eq("32K-XTAL count (32.768 kHz)", calibrate(bus, 2, MAX), Math.round((MAX * 40_000_000) / 32_768));
// A higher MAX scales the count linearly (the counter is real, not a constant):
eq("count scales with MAX", calibrate(bus, 0, 2048), Math.round((2048 * 40_000_000) / 150_000));
// CYCLING_DATA_VLD (bit 0 of RTCCALICFG1) is set with the result:
ok("CYCLING_DATA_VLD set", (bus.read32(RTCCALICFG1) & 1) === 1);

// ── Plain register-file behaviour for non-calibration registers (real, not a 0-stub) ──
bus.write32(TIMERG0_BASE + 0x00, 0xcafe0001); // T0CONFIG
eq("T0CONFIG holds its value", bus.read32(TIMERG0_BASE + 0x00), 0xcafe0001);

// ── TIMERG1 has no RTC calibration block: a START write is just a stored value ───────
const busG1 = new SystemBus(0, 0);
busG1.addDevice(new TimerGroupDevice({ base: TIMERG1_BASE, hasRtcCali: false }));
busG1.write32(TIMERG1_BASE + 0x68, (cfgWord(0, MAX) | CALI_START) >>> 0);
ok("TIMERG1 does not self-set RDY", (busG1.read32(TIMERG1_BASE + 0x68) & CALI_RDY) === 0);

console.log("");
console.log(fail === 0
  ? `ESP32 TIMER SMOKE PASS ✓  (${pass} assertions — RTC calibration counter + register file)`
  : `ESP32 TIMER SMOKE FAIL ✗  (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
