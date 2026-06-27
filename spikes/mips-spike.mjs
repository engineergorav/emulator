// Pre-M0 MIPS spike (throwaway). Answers the only question planning can't:
// can a hand-written TypeScript/JS interpreter sustain a believable frequency-
// capped Xtensa LX6, or does the WASM decision move to NOW (ADR-001 / R5)?
//
// It is NOT the real core. It's a representative fetch→decode→dispatch→execute
// loop over a synthetic Xtensa-shaped stream (variable fields, 64-entry register
// file, ALU + load/store + branch mix, real memory access via DataView). The real
// decoder (windowed regs, full ISA) will be somewhat SLOWER, so treat the number
// as an optimistic-but-honest upper band, then de-rate.
//
// Run: node lib/esp-core/spikes/mips-spike.mjs

const PROG_BYTES = 1 << 16;        // 64 KB synthetic code
const DATA_BYTES = 1 << 16;        // 64 KB data RAM for loads/stores
const N = 400_000_000;             // instructions to execute

// --- synthetic machine state ---
const code = new Uint8Array(PROG_BYTES);
const regs = new Int32Array(64);
const ram = new DataView(new ArrayBuffer(DATA_BYTES));

// Fill code with a representative instruction mix (3 bytes/instr, Xtensa-ish).
// op classes weighted like real firmware: ALU heavy, some mem, some branch.
const MIX = [0, 0, 0, 1, 1, 2, 7, 3, 3, 4, 5, 6]; // see switch below
for (let p = 0; p < PROG_BYTES; p += 3) {
  code[p] = MIX[(p / 3) % MIX.length];
  code[p + 1] = (p * 7) & 63;       // dst reg
  code[p + 2] = (p * 13) & 0xff;    // src reg / imm
}
for (let r = 0; r < 64; r++) regs[r] = (r * 2654435761) | 0;

function run(count) {
  let pc = 0;
  let executed = 0;
  let sink = 0; // defeat dead-code elimination
  const mask = PROG_BYTES - 3;
  while (executed < count) {
    // fetch (3-byte instruction)
    const op = code[pc];
    const dst = code[pc + 1] & 63;
    const src = code[pc + 2];
    const a = src & 63;
    const b = (src >> 1) & 63;

    // decode/dispatch/execute
    switch (op) {
      case 0: regs[dst] = (regs[a] + regs[b]) | 0; break;           // ADD
      case 1: regs[dst] = (regs[a] - regs[b]) | 0; break;           // SUB
      case 2: regs[dst] = regs[a] & regs[b]; break;                 // AND
      case 3: regs[dst] = (regs[dst] + (src - 128)) | 0; break;     // ADDI
      case 4: regs[dst] = ram.getInt32((regs[a] & (DATA_BYTES - 4)), true); break;        // LOAD
      case 5: ram.setInt32((regs[a] & (DATA_BYTES - 4)), regs[b], true); break;           // STORE
      case 6:                                                       // BRANCH (taken ~half)
        if ((regs[a] ^ regs[b]) & 1) { pc = (pc + 6) & mask; executed++; continue; }
        break;
      case 7: regs[dst] = regs[a] << (regs[b] & 31); break;         // SHIFT
    }

    sink ^= regs[dst];
    pc = (pc + 3) & mask;
    executed++;
  }
  return sink;
}

// warm up the JIT, then measure
run(20_000_000);
const t0 = performance.now();
const sink = run(N);
const t1 = performance.now();

const secs = (t1 - t0) / 1000;
const ips = N / secs;
const mips = ips / 1e6;

const target = (mhz, name) => {
  const ok = mips >= mhz;
  return `  ${name.padEnd(22)} ${mhz} MHz  ${ok ? "✓ reachable" : "✗ below — would need capping/WASM"}`;
};

console.log("=== Pre-M0 MIPS spike (synthetic Xtensa-shaped interpreter) ===");
console.log(`  instructions:        ${N.toLocaleString()}`);
console.log(`  wall time:           ${secs.toFixed(3)} s`);
console.log(`  throughput:          ${mips.toFixed(1)} MIPS  (${(ips / 1e6).toFixed(1)}M instr/sec)`);
console.log(`  sink (ignore):       ${sink}`);
console.log("");
console.log("  Comparison to in-repo cores + the target chip (1 instr ≈ 1 cycle):");
console.log(target(16, "avr8js (Uno)"));
console.log(target(125, "rp2040js (Pico)"));
console.log(target(240, "ESP32 LX6 (per core)"));
console.log("");
console.log("  De-rate by ~2-4x for the REAL decoder (windowed regs, full ISA, exceptions).");
console.log("  Verdict guide: if de-rated MIPS comfortably exceeds a *frequency-capped*");
console.log("  LX6 (~40-80 MHz feels live, per Wokwi's capping), TS carries M0 (ADR-001).");
console.log("  If de-rated MIPS is near/below that, WASM is a NOW decision (R5).");
