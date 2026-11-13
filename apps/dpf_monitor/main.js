'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const D = require('./dpf');
const C = require('./catalog');
const Car = require('./kit/car');
const Reader = require('./reader');
const DEMO = require('./demo');

const W = 1600, H = 520;
const PAGES = ['Now', 'Next regen', 'Regen', 'History', 'Health', 'Details'];
const BLUE = '#55aaff', GREEN = '#2fd27a';
const fmt = (v, digits) => D.finite(v) ? Number(v).toFixed(digits || 0) : '--';

function durationValue(minutes) {
    if (!D.finite(minutes)) return { text: '--', unit: '' };
    if (minutes < 120) return { text: String(Math.max(0, Math.round(minutes))), unit: 'min' };
    return { text: (minutes / 60).toFixed(1), unit: 'h' };
}

function age(rec) {
    if (!rec || !rec.at) return 'not read';
    const s = Math.max(0, Math.round((Date.now() - rec.at) / 1000));
    const a = s < 60 ? s + ' s ago' : s < 3600 ? Math.floor(s / 60) + ' min ago' : Math.floor(s / 3600) + ' h ago';
    return (rec.cached ? 'saved · ' : rec.error ? 'last good · ' : '') + a;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const reader = new Reader(ctx);
        const car = new Car(ctx, ['speed', 'temps']);
        const estimator = new D.RegenEstimator(Number(settings.get('regenTarget')) || 6);
        let page = 0;

        const demo = () => settings.get('demo') === 'on';
        const records = () => demo() ? DEMO.records : reader.records;
        const history = () => demo() ? DEMO.history : reader.history;
        const rec = (id) => records()[id];
        const val = (id, fallback) => {
            const a = rec(id), b = fallback && rec(fallback);
            return a && a.ok && D.finite(a.value) ? a.value : b && b.ok && D.finite(b.value) ? b.value : null;
        };
        const freshRec = (id, maxAge) => {
            const r = rec(id);
            return r && (demo() || D.fresh(r, Date.now(), maxAge || 15000)) ? r : null;
        };
        const liveVal = (id, fallback, maxAge) => {
            const a = freshRec(id, maxAge), b = fallback && freshRec(fallback, maxAge);
            return a ? a.value : b ? b.value : null;
        };
        const tempRecord = () => freshRec('4502', 15000) || freshRec('44EF', 15000);
        const tempC = () => { const r = tempRecord(); return r ? r.value : null; };
        const fahrenheit = () => settings.get('tempUnit') === 'F';
        const temp = (c) => D.finite(c) ? fahrenheit() ? c * 9 / 5 + 32 : c : null;
        const tempUnit = () => fahrenheit() ? '°F' : '°C';
        const vehicle = () => demo() ? DEMO.vehicle : car.data();

        function regenInfo() {
            const soot = liveVal('44BE', '44BA'), tc = tempC(), slope = D.trend(history(), 5);
            const state = D.regenState(val('44BB'), tc, slope), v = vehicle();
            const target = Number(settings.get('regenTarget')) || 6;
            estimator.setTarget(target);
            let estimate = estimator.update({ t: Date.now(), active: state.active, soot, speed: v.speed });
            if (demo()) {
                estimate = Object.assign({}, DEMO.estimate, { target });
                estimate.progress = Math.max(0, Math.min(1, (estimate.startSoot - estimate.soot) / (estimate.startSoot - target)));
                estimate.etaMinutes = (estimate.soot - target) / -estimate.rate;
                estimate.distanceRemaining = estimate.etaMinutes / 60 * estimate.averageMovingSpeed;
            }
            let next = D.nextRegenEstimate({ active: state.active,
                averageIntervalKm: val('44C7'), distanceSinceKm: val('44BF'), operatingSeconds: val('44B7'),
                successfulRegens: val('44B8'), currentSpeed: v.speed });
            if (demo() && DEMO.next) next = Object.assign({}, DEMO.next);
            return { soot, tc, slope, state, estimate, next, vehicle: v };
        }

        function wanted() {
            let ids = ['44B9', '44BA', '44BE', '44BB', '44ED', '4502', '44EF'];
            if (page === 1 || page === 2 || page === 3) ids = ids.concat(C.HISTORY);
            if (page === 4) ids = ids.concat(C.HEALTH);
            if (page === 5) ids = ids.concat(C.HISTORY, C.HEALTH);
            reader.setWanted(ids);
        }

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; wanted(); });
        ui.onClick('BTN_ACTION', () => reader.refresh());
        ctx.onTab((i, closedSheet) => {
            if (i !== page) { page = i; wanted(); }
            else if (!closedSheet) reader.refresh();
        });
        ctx.hideButton('BTN_ACTION');
        settings.onChange(() => wanted());
        ui.onVisible((name, on) => { if (name === 'MAIN') { reader.setVisible(on); if (on) wanted(); } });
        reader.setVisible(ui.isVisible('MAIN'));
        wanted();
        reader.init().catch((e) => log.warn('DPF diagnostic link: ' + e));

        function statusBadge(t) {
            const s = demo() ? 'DEMO' : reader.status();
            return { text: s, color: s === 'LIVE' ? GREEN : s === 'DEMO' ? BLUE : t.warn };
        }

        function nowPage(cv, t) {
            const soot = liveVal('44BE', '44BA'), sim = liveVal('44BA'), pressure = liveVal('44ED'), tc = tempC();
            const coolant = vehicle().coolant;
            G.stat(cv, t, 24, 44, 365, 210, { label: 'DPF soot mass', value: soot, unit: 'g', decimals: 2,
                history: history().map((p) => p.soot), color: BLUE,
                sub: freshRec('44BE') ? age(rec('44BE')) + ' · DID 44BE' : 'simulated fallback · DID 44BA' });
            G.stat(cv, t, 405, 44, 365, 210, { label: 'Before DPF', value: temp(tc), unit: tempUnit(), decimals: 0,
                zones: [{ from: temp(450), to: temp(1000), color: 'warn' }],
                sub: tempRecord() ? age(tempRecord()) + ' · DID ' + (tempRecord() === rec('4502') ? '4502' : '44EF') : 'waiting for fresh DDE sample' });
            G.stat(cv, t, 786, 44, 365, 210, { label: 'Differential pressure', value: pressure, unit: 'hPa', decimals: 1,
                sub: 'flow-dependent · DID 44ED' });
            G.stat(cv, t, 1167, 44, 409, 210, { label: 'Coolant', value: temp(coolant), unit: tempUnit(), decimals: 0,
                color: GREEN, sub: 'native vehicle temperature signal' });

            G.panel(cv, t, 24, 270, 1552, 242, 'Last 20 minutes');
            const now = Date.now(), pts = history().map((p) => [(p.t - now) / 60000, p.soot]);
            const ys = pts.map((p) => p[1]).filter(D.finite), lo = ys.length ? Math.max(0, Math.floor(Math.min.apply(null, ys) - 2)) : 0;
            const hi = ys.length ? Math.max(lo + 5, Math.ceil(Math.max.apply(null, ys) + 2)) : 50;
            G.chart(cv, t, 44, 324, 1510, 168, { xMin: -20, xMax: 0, xStep: 5, yMin: lo, yMax: hi,
                xFmt: (v) => v === 0 ? 'now' : String(v), xUnit: 'min', yUnit: 'g',
                series: [{ pts, color: BLUE, width: 3, fill: 0.12 }], empty: 'Waiting for soot history' });
            if (D.finite(sim)) cv.text('Simulated soot now: ' + fmt(sim, 2) + ' g', 1538, 294, 18, t.dim, { align: 'right' });
        }

        function regenPage(cv, t, info) {
            const e = info.estimate, active = info.state.active, p = e && e.progress;
            const percent = D.finite(p) ? Math.round(p * 100) : null;
            const eta = e && D.finite(e.etaMinutes) ? Math.max(0, Math.ceil(e.etaMinutes)) : null;
            const left = e && D.finite(e.distanceRemaining) ? Math.max(0, e.distanceRemaining) : null;
            G.panel(cv, t, 24, 44, 760, 468, 'Regeneration progress · estimated');
            G.pill(cv, t, 48, 86, 712, 48, info.state.text,
                { color: active ? t.warn : info.state.color === 'warn' ? t.warn : t.dim, size: 19 });
            G.readout(cv, t, 48, 160, { label: 'Progress to soot target', text: percent == null ? '--' : String(percent), unit: '%', size: 72,
                color: active ? GREEN : t.dim });
            cv.roundRect(48, 254, 712, 24, 12, t.track);
            if (D.finite(p) && p > 0) cv.rampRect(48, 254, Math.max(24, 712 * p), 24, 12, [t.warn, GREEN], 48, 712);
            const start = e && D.finite(e.startSoot) ? fmt(e.startSoot, 1) + ' g start' : '-- start';
            const current = D.finite(info.soot) ? fmt(info.soot, 1) + ' g now' : '-- now';
            const target = e && D.finite(e.target) ? fmt(e.target, 0) + ' g target' : '-- target';
            cv.text(start, 48, 315, 20, t.dim);
            cv.text(current, 404, 315, 20, t.text, { align: 'center' });
            cv.text(target, 760, 315, 20, t.dim, { align: 'right' });
            const rate = e && D.finite(e.rate) ? (e.rate > 0 ? '+' : '') + e.rate.toFixed(2) + ' g/min' : 'calibrating burn rate';
            cv.text('Measured soot rate: ' + rate, 48, 375, 23, active && D.finite(e.rate) ? GREEN : t.dim);
            const raw = D.finite(info.state.rawCode) ? String(info.state.rawCode) : '--';
            cv.text('Raw 44BB code: ' + raw + ' · shown for diagnostics, not interpreted as a request.', 48, 420, 19, t.dim);
            cv.text(active ? 'Keep driving normally and follow the road—not this screen.' : 'Estimates appear after an active regeneration and enough soot samples.',
                48, 474, 20, active ? t.text : t.dim);

            G.panel(cv, t, 808, 44, 368, 218, 'Time remaining');
            G.readout(cv, t, 832, 102, { text: eta == null ? active ? 'CALIBRATING' : '--' : String(eta), unit: eta == null ? '' : 'min',
                size: eta == null && active ? 31 : 72, font: eta == null && active ? 'bold' : 'num', color: eta == null ? t.dim : BLUE });
            cv.text('from measured soot burn rate', 832, 235, 18, t.dim);
            G.panel(cv, t, 1200, 44, 376, 218, 'Distance remaining');
            G.readout(cv, t, 1224, 102, { text: left == null ? active ? 'CALIBRATING' : '--' : fmt(left, 1), unit: left == null ? '' : 'km',
                size: left == null && active ? 29 : 72, font: left == null && active ? 'bold' : 'num', color: left == null ? t.dim : BLUE });
            cv.text('using average moving speed', 1224, 235, 18, t.dim);

            const session = [
                ['Elapsed this regeneration', e && D.finite(e.elapsedMinutes) ? fmt(e.elapsedMinutes, 0) + ' min' : '--'],
                ['Driven this regeneration', e && D.finite(e.distance) ? fmt(e.distance, 1) + ' km' : '--'],
                ['Distance since previous regen', D.finite(val('44BF')) ? fmt(val('44BF'), 1) + ' km' : '--'],
                ['Coolant', D.finite(info.vehicle.coolant) ? fmt(temp(info.vehicle.coolant), 0) + tempUnit() : '--'],
            ];
            G.panel(cv, t, 808, 278, 768, 234, 'Session');
            G.table(cv, t, 832, 318, 720, [{ label: 'Measure', w: 480 }, { label: 'Value', w: 220, align: 'right' }], session,
                { rowH: 42, size: 22, middle: true });
        }

        function nextRegenPage(cv, t, info) {
            const e = info.next || {}, ready = !!e.ready, active = !!e.active;
            const pct = ready && D.finite(e.progress) ? Math.round(e.progress * 100) : null;
            const distance = ready && D.finite(e.remainingDistance) ? e.remainingDistance : null;
            const eta = durationValue(ready ? e.etaMinutes : null);
            const stateColor = active ? t.warn : ready ? (e.status === 'DUE WINDOW' ? t.warn : GREEN) : t.dim;

            G.panel(cv, t, 24, 44, 760, 468, 'Next regeneration start · estimated');
            G.pill(cv, t, 48, 86, 712, 48, e.status || 'LEARNING', { color: stateColor, size: 19 });
            G.readout(cv, t, 48, 160, { label: 'Learned interval used', text: pct == null ? '--' : String(pct), unit: '%',
                size: 72, color: ready ? BLUE : t.dim });
            cv.roundRect(48, 254, 712, 24, 12, t.track);
            if (ready && D.finite(e.progress) && e.progress > 0) {
                cv.rampRect(48, 254, Math.max(24, 712 * e.progress), 24, 12, [BLUE, t.warn], 48, 712);
            }
            cv.text('Previous regen', 48, 315, 19, t.dim);
            cv.text(ready ? fmt(e.distanceSinceKm, 1) + ' km driven' : '--', 404, 315, 21, t.text, { align: 'center' });
            cv.text(ready ? fmt(e.intervalKm, 0) + ' km learned' : '--', 760, 315, 19, t.dim, { align: 'right' });
            cv.text(D.finite(info.soot) ? 'Current measured soot: ' + fmt(info.soot, 1) + ' g' : 'Current measured soot: --',
                48, 375, 23, D.finite(info.soot) ? GREEN : t.dim);
            const message = active
                ? 'The current regeneration has already started. The following cycle can be projected after it completes.'
                : ready ? 'Projection follows the DDE learned average; actual start changes with load, temperature and driving.'
                    : 'Waiting for the DDE learned interval and distance-since-regeneration counters.';
            cv.text(message, 48, 430, 19, active ? t.warn : t.dim);
            cv.text('Time means engine-running driving time, not calendar time.', 48, 474, 19, t.dim);

            G.panel(cv, t, 808, 44, 368, 218, 'Driving time to start');
            G.readout(cv, t, 832, 102, { text: active ? 'IN PROGRESS' : eta.text, unit: active ? '' : eta.unit,
                size: active ? 29 : 72, font: active ? 'bold' : 'num', color: active || !ready ? t.dim : BLUE });
            cv.text(ready && e.timeBasis ? 'using ' + e.timeBasis : 'waiting for a speed basis', 832, 235, 18, t.dim);
            G.panel(cv, t, 1200, 44, 376, 218, 'Distance to start');
            G.readout(cv, t, 1224, 102, { text: active ? 'IN PROGRESS' : distance == null ? '--' : fmt(distance, 1),
                unit: active || distance == null ? '' : 'km', size: active ? 29 : 72, font: active ? 'bold' : 'num',
                color: active || !ready ? t.dim : BLUE });
            cv.text('remaining in learned interval', 1224, 235, 18, t.dim);

            G.panel(cv, t, 808, 278, 768, 234, 'Estimate basis');
            const rows = [
                ['BMW learned interval', ready ? fmt(e.intervalKm, 0) + ' km' : '--'],
                ['Distance since last successful regen', ready ? fmt(e.distanceSinceKm, 1) + ' km' : '--'],
                ['Average speed since last regen', D.finite(e.averageSpeed) ? fmt(e.averageSpeed, 1) + ' km/h' : '--'],
                ['Successful regenerations stored', D.finite(e.successfulRegens) ? fmt(e.successfulRegens, 0) : '--'],
            ];
            G.table(cv, t, 832, 318, 720, [{ label: 'Measure', w: 480 }, { label: 'Value', w: 220, align: 'right' }], rows,
                { rowH: 42, size: 22, middle: true });
            cv.text(ready ? e.confidence + ' CONFIDENCE' : 'LEARNING', 1548, 492, 17, ready ? GREEN : t.dim, { align: 'right' });
        }

        function historyPage(cv, t) {
            const cards = [
                ['Distance since last successful regen', val('44BF'), 'km', 1, '44BF'],
                ['Operating time since last successful regen', D.finite(val('44B7')) ? val('44B7') / 3600 : null, 'h', 1, '44B7'],
                ['Fuel since last successful regen', val('44BC'), 'l', 2, '44BC'],
                ['Average regeneration interval', val('44C7'), 'km', 0, '44C7'],
                ['Mileage at last successful regen', val('44D1'), 'km', 0, '44D1'],
                ['Successful regenerations stored', val('44B8'), '', 0, '44B8'],
            ];
            cards.forEach((c, i) => {
                const x = 24 + (i % 3) * 517, y = 44 + Math.floor(i / 3) * 234;
                G.stat(cv, t, x, y, 493, 218, { label: c[0], value: c[1], unit: c[2], decimals: c[3],
                    color: i < 3 ? BLUE : GREEN, sub: age(rec(c[4])) + ' · DID ' + c[4] });
            });
        }

        function healthPage(cv, t) {
            G.stat(cv, t, 24, 44, 493, 218, { label: 'Oil ash mass', value: val('44BD'), unit: 'g', decimals: 1,
                color: BLUE, sub: age(rec('44BD')) + ' · DID 44BD' });
            G.stat(cv, t, 541, 44, 493, 218, { label: 'CBS DPF remaining distance', value: val('4C78'), unit: 'km', decimals: 0,
                color: GREEN, sub: 'condition-based service value · DID 4C78' });
            G.stat(cv, t, 1058, 44, 518, 218, { label: 'Corrected soot channel', value: val('44B9'), unit: 'g', decimals: 2,
                color: BLUE, sub: 'auxiliary comparison · DID 44B9' });
            G.panel(cv, t, 24, 278, 760, 234, 'Raw regeneration status');
            G.table(cv, t, 48, 318, 710,
                [{ label: 'Signal', w: 430 }, { label: 'Code', w: 120, align: 'right' }, { label: 'DID', w: 130, align: 'right' }],
                [
                    ['Request/reason (raw)', fmt(val('44BB')), '44BB'],
                    ['Interruption', fmt(val('44C0')), '44C0'],
                    ['Block / release', fmt(val('44C2')), '44C2'],
                ], { rowH: 49, size: 23, middle: true });
            G.panel(cv, t, 808, 278, 768, 234, 'How to read this page');
            const notes = [
                'Ash is not soot: ash accumulates and does not burn away.',
                "CBS remaining distance is BMW's service estimate, not a load percentage.",
                'Status codes are shown raw until their meanings are verified on this DDE.',
                'No reset, forced regeneration, coding or write command exists in this app.',
            ];
            notes.forEach((s, i) => cv.text(s, 834, 365 + i * 38, 21, i === 3 ? GREEN : t.text));
        }

        function detailsPage(cv, t) {
            const variant = demo() ? DEMO.variantName : reader.variantName;
            const index = demo() ? DEMO.sgbd : reader.sgbd || '--';
            G.panel(cv, t, 24, 44, 520, 468, 'Diagnostic link');
            G.readout(cv, t, 48, 93, { label: 'DDE variant', text: variant, size: variant.length > 16 ? 31 : 38, font: 'bold', color: BLUE });
            G.readout(cv, t, 48, 190, { label: 'SGBD index', text: index, size: 42, font: 'bold' });
            const status = demo() ? 'DEMO' : reader.status();
            G.pill(cv, t, 48, 275, 210, 46, status, { color: status === 'LIVE' ? GREEN : BLUE, size: 18 });
            cv.text('DDE address 0x12', 48, 367, 22, t.text);
            cv.text('Only UDS service 0x22 is used', 48, 407, 22, GREEN);
            cv.text('Last error: ' + (reader.lastError || 'none'), 48, 463, 18, reader.lastError ? t.warn : t.dim);

            G.panel(cv, t, 568, 44, 1008, 468, 'Read identifiers');
            const ids = ['44BE', '44BA', '44B9', '44BB', '44ED', '4502', '44EF', '44BF'];
            const rows = ids.map((id) => {
                const r = rec(id), value = r && r.ok ? fmt(r.value, Math.abs(r.value) < 100 ? 2 : 0) : '--';
                return [C.records[id].label, value, id, age(r)];
            });
            G.table(cv, t, 592, 82, 960,
                [{ label: 'Signal', w: 430 }, { label: 'Value', w: 130, align: 'right' }, { label: 'DID', w: 100, align: 'right' }, { label: 'Age', w: 280, align: 'right' }],
                rows, { rowH: 49, size: 20, middle: true });
        }

        ctx.loop('MAIN', 60, () => {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            const info = regenInfo();
            G.frame(cv, t, PAGES, page, [{ text: 'READ ONLY', color: GREEN }, statusBadge(t)]);
            if (!demo() && reader.checked && !reader.supported) {
                cv.text('This DDE variant is not in the verified DPF catalog', 800, 245, 34, t.warn, { align: 'center' });
                cv.text('SGBD index ' + reader.sgbd + ' · Settings can try the shared layout as unverified', 800, 300, 23, t.dim, { align: 'center' });
            } else [nowPage, (c, th) => nextRegenPage(c, th, info), (c, th) => regenPage(c, th, info),
                historyPage, healthPage, detailsPage][page](cv, t);
            return ui.image('MAIN_GFX', cv);
        });
    },
});
