'use strict';

const C = require('./catalog');
const S = require('./kit/sgbd');
const finite = (v) => typeof v === 'number' && isFinite(v);

function fresh(rec, now, maxAge) {
    return !!(rec && rec.ok && finite(rec.value) && !rec.cached && rec.at && now - rec.at >= 0 && now - rec.at <= maxAge);
}

function payload(did, uds) {
    const b = Buffer.from(uds || []), n = parseInt(did, 16);
    if (b.length < 3 || b[0] !== 0x62 || b[1] !== (n >> 8) || b[2] !== (n & 255)) return null;
    return b.slice(3);
}

function decode(did, uds) {
    did = String(did).toUpperCase();
    const meta = C.records[did], b = payload(did, uds);
    if (!meta || !b) return { ok: false, error: 'No matching positive response' };
    if (b.length !== meta.length) return { ok: false, error: 'Unexpected length: ' + b.length + ', expected ' + meta.length };
    const out = S.field(Array.from(b), meta.field);
    if (!out || out.why || !finite(out.value)) return { ok: false, error: out && out.why || 'Could not decode value' };
    return { ok: true, value: out.value, raw: out.raw, bytes: b.length };
}

/**
 * Conservative indication. 44BB is retained as a raw code but is not a verified boolean on D83,
 * so it must never by itself produce REQUESTED or ACTIVE. Activity requires both heat and a
 * falling soot trend; it is still explicitly labelled as inferred.
 */
function regenState(requestCode, temperature, sootTrend) {
    const hot = finite(temperature) && temperature >= 450;
    const falling = finite(sootTrend) && sootTrend < -0.02;
    const rawCode = finite(requestCode) ? requestCode : null;
    if (hot && falling) return { text: 'ACTIVE · INFERRED', color: 'warn', active: true, rawCode };
    if (hot) return { text: 'FILTER HOT', color: 'warn', active: false, rawCode };
    return { text: 'NOT DETECTED', color: 'dim', active: false, rawCode };
}

/** Grams per minute over recent measured-soot samples, using first/last valid points. */
function trend(history, minutes) {
    const cutoff = Date.now() - (minutes || 5) * 60000;
    const xs = (history || []).filter((p) => p.t >= cutoff && finite(p.soot));
    if (xs.length < 2 || xs[xs.length - 1].t === xs[0].t) return null;
    return (xs[xs.length - 1].soot - xs[0].soot) / ((xs[xs.length - 1].t - xs[0].t) / 60000);
}

/** Linear soot change in g/min over the recent part of a session. */
function sessionRate(samples, now, minutes) {
    const cutoff = now - (minutes || 5) * 60000;
    const xs = (samples || []).filter((p) => p.t >= cutoff && finite(p.soot));
    if (xs.length < 2) return null;
    const mt = xs.reduce((a, p) => a + p.t, 0) / xs.length;
    const mv = xs.reduce((a, p) => a + p.soot, 0) / xs.length;
    let num = 0, den = 0;
    xs.forEach((p) => { num += (p.t - mt) * (p.soot - mv); den += (p.t - mt) * (p.t - mt); });
    return den ? num / den * 60000 : null;
}

/**
 * Projects the start of the next regeneration from the DDE's own learned average interval.
 * Time is driving/engine-running time, derived from this cycle's distance and operating time;
 * calendar time cannot be predicted because soot accumulation depends on how the car is used.
 */
function nextRegenEstimate(sample) {
    sample = sample || {};
    if (sample.active) return { status: 'CURRENT REGEN ACTIVE', active: true, ready: false };
    const interval = sample.averageIntervalKm, distance = sample.distanceSinceKm;
    if (!finite(interval) || interval < 20 || interval > 2000 || !finite(distance) || distance < 0 || distance > 10000) {
        return { status: 'LEARNING', active: false, ready: false };
    }
    const remainingDistance = Math.max(0, interval - distance);
    const progress = Math.max(0, Math.min(1, distance / interval));
    let averageSpeed = null, timeBasis = '';
    if (finite(sample.operatingSeconds) && sample.operatingSeconds >= 600 && distance >= 1) {
        const cycleSpeed = distance / (sample.operatingSeconds / 3600);
        if (cycleSpeed >= 1 && cycleSpeed <= 180) { averageSpeed = cycleSpeed; timeBasis = 'cycle average'; }
    }
    if (!finite(averageSpeed) && finite(sample.currentSpeed) && sample.currentSpeed >= 5 && sample.currentSpeed <= 250) {
        averageSpeed = sample.currentSpeed;
        timeBasis = 'current speed fallback';
    }
    const etaMinutes = finite(averageSpeed) && averageSpeed > 0 ? remainingDistance / averageSpeed * 60 : null;
    const count = sample.successfulRegens;
    const confidence = finite(count) && count >= 10 && timeBasis === 'cycle average' ? 'HIGH'
        : finite(count) && count >= 3 ? 'MEDIUM' : 'LOW';
    const dueWindow = remainingDistance <= Math.max(15, interval * 0.03);
    return { status: dueWindow ? 'DUE WINDOW' : 'PROJECTED', active: false, ready: true,
        intervalKm: interval, distanceSinceKm: distance, remainingDistance, progress,
        averageSpeed, etaMinutes, timeBasis, successfulRegens: finite(count) ? count : null, confidence };
}

/**
 * One inferred regeneration session. Distance integrates the car-speed signal; completion uses
 * the measured soot burn rate and an explicitly configurable soot target. Nothing here commands
 * or resets the DDE.
 */
class RegenEstimator {
    constructor(target) {
        this.target = finite(target) ? target : 6;
        this.session = null;
        this.completed = null;
    }

    setTarget(target) { if (finite(target)) this.target = target; }

    update(sample) {
        const t = finite(sample.t) ? sample.t : Date.now();
        const soot = sample.soot, speed = sample.speed;
        if (sample.active && finite(soot)) {
            if (!this.session) {
                this.session = { startedAt: t, startSoot: soot, lastAt: t, lastSpeed: finite(speed) ? speed : 0,
                    distance: 0, movingMs: 0, samples: [{ t, soot }], inactiveAt: 0 };
                this.completed = null;
            }
            const s = this.session, dt = Math.max(0, Math.min(10000, t - s.lastAt));
            const v0 = finite(s.lastSpeed) ? s.lastSpeed : 0, v1 = finite(speed) ? speed : v0;
            s.distance += Math.max(0, (v0 + v1) / 2) * dt / 3600000;
            if ((v0 + v1) / 2 > 5) s.movingMs += dt;
            s.lastAt = t; s.lastSpeed = v1; s.inactiveAt = 0;
            const last = s.samples[s.samples.length - 1];
            if (!last || t - last.t >= 5000) s.samples.push({ t, soot });
            s.samples = s.samples.filter((p) => p.t >= t - 20 * 60000).slice(-300);
        } else if (this.session) {
            const s = this.session;
            if (!s.inactiveAt) s.inactiveAt = t;
            // Avoid ending a session on a single stale diagnostic cycle.
            if (t - s.inactiveAt >= 30000) {
                this.completed = this.snapshot(t);
                this.completed.active = false;
                this.session = null;
            }
        }
        return this.snapshot(t);
    }

    snapshot(now) {
        const s = this.session;
        if (!s) return this.completed || { active: false, progress: null, etaMinutes: null, distanceRemaining: null };
        const last = s.samples[s.samples.length - 1], soot = last && last.soot;
        const span = s.startSoot - this.target;
        const progress = finite(soot) && span > 0.5 ? Math.max(0, Math.min(1, (s.startSoot - soot) / span)) : null;
        const rate = sessionRate(s.samples, now, 5);
        const etaMinutes = finite(rate) && rate < -0.02 && soot > this.target ? Math.min(180, (soot - this.target) / -rate) : null;
        const avgSpeed = s.movingMs > 10000 ? s.distance / (s.movingMs / 3600000)
            : finite(s.lastSpeed) && s.lastSpeed > 5 ? s.lastSpeed : null;
        const distanceRemaining = finite(etaMinutes) && finite(avgSpeed) ? etaMinutes / 60 * avgSpeed : null;
        return { active: true, startedAt: s.startedAt, startSoot: s.startSoot, soot, target: this.target,
            progress, rate, etaMinutes, distanceRemaining, elapsedMinutes: Math.max(0, (now - s.startedAt) / 60000),
            distance: s.distance, averageMovingSpeed: avgSpeed, calibrating: !finite(etaMinutes) };
    }
}

module.exports = { decode, payload, regenState, trend, sessionRate, nextRegenEstimate, RegenEstimator, finite, fresh };
