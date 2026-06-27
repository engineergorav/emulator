// M2.3 RTC controller smoke test. Drives the RTC time counter the way rtc_time_get does
// — request a latch (TIME_UPDATE bit31), poll TIME_VALID (bit30), read TIME0/TIME1 — and
// asserts the counter (a) reads back valid, (b) advances with the supplied cycle count
// (so firmware busy-waits terminate), and (c) reports the XTAL frequency from STORE4.
// Deterministic + toolchain-free (the real-.bin reach through rtc_time_get is the probe).
//
// Run: node lib/esp-core/test/esp32-rtc-smoke.mjs
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
const tmp = "D:/Routing-Engine/lib/esp-core/test/_rtc_bundle.mjs";
writeFileSync(tmp, res.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
const { SystemBus, RtcCntlDevice, RTC_CNTL_BASE } = mod;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = got >>> 0, w = want >>> 0;
  if (g === w) { pass++; }
  else { fail++; console.log(`  ✗ ${name}: got 0x${g.toString(16)} (${g}), want 0x${w.toString(16)} (${w})`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}`); } };

const TIME_UPDATE = RTC_CNTL_BASE + 0x0c;
const TIME0 = RTC_CNTL_BASE + 0x10;
const TIME1 = RTC_CNTL_BASE + 0x14;
const STORE4 = RTC_CNTL_BASE + 0xb0;
const UPDATE_BIT = 0x80000000;
const VALID_BIT = 0x40000000;

// Time base we control: a fake CPU-cycle counter the device reads via now().
let cycles = 0;
const cpuHz = 240_000_000, rtcSlowHz = 150_000;
const bus = new SystemBus(0, 0);
bus.addDevice(new RtcCntlDevice({ now: () => cycles, cpuHz, rtcSlowHz, xtalFreqMhz: 40 }));

// rtc_time_get: latch + poll TIME_VALID + read. (We complete the latch instantly, so
// TIME_VALID is set as soon as the request is written — firmware re-requests each call.)
function rtcTimeGet() {
  bus.write32(TIME_UPDATE, bus.read32(TIME_UPDATE) | UPDATE_BIT); // request latch (RMW)
  ok("TIME_VALID set after update", (bus.read32(TIME_UPDATE) & VALID_BIT) !== 0);
  const lo = bus.read32(TIME0) >>> 0;
  const hi = bus.read32(TIME1) >>> 0;
  return hi * 2 ** 32 + lo;
}

// XTAL frequency store register (low16 == high16 == MHz).
eq("STORE4 XTAL freq = 40 MHz", bus.read32(STORE4), 0x00280028);

// At cycle 0 the counter is 0.
eq("counter starts at 0", rtcTimeGet(), 0);

// After 1,600,000 CPU cycles → 1,600,000 * 150000 / 240000000 = 1000 RTC ticks.
cycles = 1_600_000;
eq("counter advanced to 1000 ticks", rtcTimeGet(), Math.floor((cycles * rtcSlowHz) / cpuHz));

// Monotonic: a later read is strictly greater (this is what makes busy-waits terminate).
cycles = 4_000_000;
const t = rtcTimeGet();
ok("counter is monotonic & advancing", t === Math.floor((cycles * rtcSlowHz) / cpuHz) && t > 1000);

// A stale read without a new TIME_UPDATE keeps the last latched value (no re-latch).
cycles = 9_999_999;
eq("TIME0 holds last latch until re-updated", bus.read32(TIME0) >>> 0, t >>> 0);

console.log("");
console.log(fail === 0
  ? `ESP32 RTC SMOKE PASS ✓  (${pass} assertions — RTC time counter + XTAL store)`
  : `ESP32 RTC SMOKE FAIL ✗  (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
