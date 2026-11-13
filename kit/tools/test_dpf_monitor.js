'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');

// Stage the app and its exact dependencies as the build does; source apps do not carry a kit/ directory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpf-monitor-test-'));
fs.mkdirSync(path.join(tmp, 'kit'));
for (const name of ['reader', 'catalog', 'dpf']) fs.copyFileSync(path.join(root, 'apps/dpf_monitor', name + '.js'), path.join(tmp, name + '.js'));
for (const name of ['readonly-diag', 'diag', 'sgbd']) fs.copyFileSync(path.join(root, 'kit/runtime', name + '.js'), path.join(tmp, 'kit', name + '.js'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const D = require(path.join(tmp, 'dpf'));
const C = require(path.join(tmp, 'catalog'));

function reply(did, raw, bytes) {
    const b = Buffer.alloc(3 + bytes);
    b[0] = 0x62; b.writeUInt16BE(parseInt(did, 16), 1);
    if (bytes === 1) b.writeUInt8(raw, 3);
    else if (bytes === 2) b.writeUInt16BE(raw, 3);
    else if (bytes === 4) b.writeUInt32BE(raw, 3);
    return b;
}

assert.strictEqual(D.decode('44B9', reply('44B9', 1842, 2)).value, 18.42);
assert(Math.abs(D.decode('44BE', reply('44BE', 1026, 2)).value - 15.65575452) < 0.000001);
assert.strictEqual(D.decode('44BF', reply('44BF', 284700, 4)).value, 284.7);
assert(Math.abs(D.decode('44ED', reply('44ED', 22311, 2)).value - 21.4) < 0.1);
assert(Math.abs(D.decode('4502', reply('4502', 12116, 2)).value - 329) < 0.1);
assert.strictEqual(D.decode('44B9', reply('44BA', 1842, 2)).ok, false);
assert.strictEqual(D.decode('44B9', reply('44B9', 42, 1)).ok, false);
assert.strictEqual(D.regenState(1, 610, 0.1).text, 'FILTER HOT');
assert.strictEqual(D.regenState(1, 610, 0.1).active, false);
assert.strictEqual(D.regenState(1, 250, 0.1).text, 'NOT DETECTED');
assert.strictEqual(D.regenState(1, 250, 0.1).rawCode, 1);
assert.strictEqual(D.regenState(0, 540, -0.05).text, 'ACTIVE · INFERRED');
assert.strictEqual(D.regenState(0, 300, 0.02).text, 'NOT DETECTED');
assert.strictEqual(D.fresh({ ok: true, value: 147, at: 990000, cached: false }, 1000000, 15000), true);
assert.strictEqual(D.fresh({ ok: true, value: 147, at: 980000, cached: false }, 1000000, 15000), false);
assert.strictEqual(D.fresh({ ok: true, value: 147, at: 999000, cached: true }, 1000000, 15000), false);
assert.strictEqual(C.variants['0F2670'], 'D83BX7C0');

const realNow = Date.now;
Date.now = () => 1_000_000;
assert.strictEqual(D.trend([{ t: 700000, soot: 20 }, { t: 1000000, soot: 19 }], 5), -0.2);
Date.now = realNow;

const estimate = new D.RegenEstimator(6);
let es;
for (let i = 0; i <= 24; i++) es = estimate.update({ t: i * 5000, active: true, soot: 24 - i * 0.05, speed: 60 });
assert(es.active && es.progress > 0.06 && es.progress < 0.07);
assert(Math.abs(es.rate + 0.6) < 0.001);
assert(Math.abs(es.etaMinutes - 28) < 0.01);
assert(Math.abs(es.distance - 2) < 0.01);
assert(Math.abs(es.distanceRemaining - 28) < 0.01);
estimate.update({ t: 125000, active: false, soot: 22.8, speed: 60 });
assert.strictEqual(estimate.snapshot(125000).active, true, 'one stale cycle must not end the session');
estimate.update({ t: 160000, active: false, soot: 22.8, speed: 60 });
assert.strictEqual(estimate.snapshot(160000).active, false, '30 seconds without detection ends the session');

const next = D.nextRegenEstimate({ averageIntervalKm: 462, distanceSinceKm: 284.7,
    operatingSeconds: 12640, successfulRegens: 347, currentSpeed: 76, active: false });
assert.strictEqual(next.status, 'PROJECTED');
assert.strictEqual(next.ready, true);
assert(Math.abs(next.remainingDistance - 177.3) < 0.001);
assert(Math.abs(next.averageSpeed - 81.085443) < 0.001);
assert(Math.abs(next.etaMinutes - 131.19) < 0.1);
assert.strictEqual(next.timeBasis, 'cycle average');
assert.strictEqual(next.confidence, 'HIGH');
const due = D.nextRegenEstimate({ averageIntervalKm: 400, distanceSinceKm: 410,
    operatingSeconds: 20000, successfulRegens: 20, active: false });
assert.strictEqual(due.status, 'DUE WINDOW');
assert.strictEqual(due.remainingDistance, 0);
assert.strictEqual(due.etaMinutes, 0);
assert.strictEqual(D.nextRegenEstimate({ active: true }).status, 'CURRENT REGEN ACTIVE');
assert.strictEqual(D.nextRegenEstimate({ averageIntervalKm: 65535, distanceSinceKm: 20 }).ready, false);

const Reader = require(path.join(tmp, 'reader'));

(async () => {
    let policy = 'verified';
    const ctx = { dataDir: tmp, settings: { get: (k) => k === 'variantPolicy' ? policy : k === 'liveInterval' ? 2 : 'off' },
        signals: {}, log: { info() {}, warn() {}, error() {} } };
    const r = new Reader(ctx), calls = [];
    r.diag = {
        available: true, ready: true, wake() {}, cancel() {},
        read: async (address, did) => {
            calls.push({ address, did });
            if (did === 0xF150) return Buffer.from('62f1500f2670', 'hex');
            if (did === 0x44B9) return reply('44B9', 1842, 2);
            if (did === 0x44BE) return reply('44BE', 1026, 2);
            return Buffer.from([0x7F, 0x22, 0x31]);
        },
    };
    await r.identify();
    assert(r.checked && r.supported && r.variantName === 'D83BX7C0');
    await r.read('44B9');
    assert.strictEqual(r.records['44B9'].value, 18.42);
    assert(calls.every((x) => x.address === 0x12));
    assert.deepStrictEqual(calls.map((x) => x.did), [0xF150, 0x44B9]);
    await assert.rejects(() => r.read('FFFF'), /allowed DPF read/);
    r.setWanted(['44B9', '44BA', '44BE', '4502']);
    r.attempts = {};
    assert.deepStrictEqual([r.nextDue(10000, 2000), r.nextDue(10000, 2000), r.nextDue(10000, 2000), r.nextDue(10000, 2000)],
        ['44B9', '44BA', '44BE', '4502'], 'live DIDs must be selected fairly in round-robin order');
    await r.read('44BE');
    assert.strictEqual(r.history.length, 1, 'a successful 44BE read must create primary soot history');
    assert(Math.abs(r.history[0].soot - 15.65575452) < 0.000001);
    console.log('DPF Monitor synthetic decoder/read-only checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
