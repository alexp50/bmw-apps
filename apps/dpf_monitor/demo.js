'use strict';

const now = Date.now();
const values = {
    '44B7': 12640, '44B8': 347, '44B9': 18.42, '44BA': 19.08, '44BB': 1,
    '44BC': 24.76, '44BD': 31.6, '44BE': 18.9, '44BF': 284.7,
    '44C0': 0, '44C2': 0, '44C7': 462, '44D1': 148315,
    '44ED': 21.4, '44EF': 604, '4502': 610, '4C78': 168000,
};
const records = {};
Object.keys(values).forEach((id) => { records[id] = { ok: true, value: values[id], at: now, cached: false }; });
const history = Array.from({ length: 121 }, (_, i) => ({
    t: now - (120 - i) * 10000,
    soot: 25.3 - i * 0.057 + Math.sin(i / 9) * 0.05,
}));

module.exports = {
    records, history, sgbd: '0F2670', variantName: 'D83BX7C0', vehicle: { coolant: 91, speed: 76 },
    estimate: { active: true, startSoot: 25.3, soot: 18.42, target: 6, progress: 0.356, rate: -0.34,
        etaMinutes: 36.5, distanceRemaining: 46.2, elapsedMinutes: 20, distance: 25.3, averageMovingSpeed: 76 },
    next: { status: 'PROJECTED', active: false, ready: true, intervalKm: 462, distanceSinceKm: 284.7,
        remainingDistance: 177.3, progress: 284.7 / 462, averageSpeed: 81.1, etaMinutes: 131.2,
        timeBasis: 'cycle average', successfulRegens: 347, confidence: 'HIGH' },
};
