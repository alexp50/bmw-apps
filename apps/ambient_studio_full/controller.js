'use strict';
const fs = require('fs');
const path = require('path');
const D = require('./catalog');

const MIN_WRITE_MS = 1200;
const FLASH_MS = 1500;

class Controller {
    constructor(ctx, changed, translate = (text) => text) {
        this.ctx = ctx; this.changed = changed || (() => {});
        this.translate = translate;
        this.file = path.join(ctx.dataDir, 'ambient-studio.json');
        this.palette = {}; this.modeEnabled = false; this.hazardEnabled = false; this.doorEnabled = false;
        this.hazardLearn = { off: null, on: null };
        this.mode = null; this.color = null; this.lightState = null; this.engine = null;
        this.hazardRaw = null; this.hazard = null; this.door = null; this.doorProvider = false;
        this.connections = {}; this.closed = false; this.busy = false; this.pending = false;
        this.lastWriteAt = 0; this.lastWrite = 'none'; this.notice = ''; this.flashOn = true;
        this.alertRestore = null; this.lastNormalColor = null;
        this.load();
    }
    message(key, values) {
        return this.translate(key).replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
    }
    load() {
        try {
            const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            D.SEMANTIC.forEach((k) => { if (D.COLORS.some((c) => c.value === (s.palette || {})[k])) this.palette[k] = s.palette[k]; });
            this.modeEnabled = s.modeEnabled === true;
            this.hazardEnabled = s.hazardEnabled === true;
            this.doorEnabled = s.doorEnabled === true;
            this.hazardLearn.off = s.hazardLearn && typeof s.hazardLearn.off === 'string' ? s.hazardLearn.off : null;
            this.hazardLearn.on = s.hazardLearn && typeof s.hazardLearn.on === 'string' ? s.hazardLearn.on : null;
        } catch (e) { if (e.code !== 'ENOENT') this.notice = 'Saved settings could not be read: ' + e.message; }
    }
    save() {
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ palette: this.palette, modeEnabled: this.modeEnabled,
            hazardEnabled: this.hazardEnabled, doorEnabled: this.doorEnabled, hazardLearn: this.hazardLearn }, null, 2));
        fs.renameSync(tmp, this.file);
    }
    paletteReady() { return D.SEMANTIC.every((k) => D.COLORS.some((c) => c.value === this.palette[k])); }
    learnColor(name) {
        if (D.SEMANTIC.indexOf(name) < 0) throw new Error('Unknown named colour');
        if (!D.COLORS.some((c) => c.value === this.color)) throw new Error('No factory colour is currently reported');
        this.palette[name] = this.color; this.save();
        this.notice = this.message('{colour} learned as factory slot {slot}', {
            colour: this.translate(name[0] + name.slice(1).toLowerCase()), slot: this.color
        });
        this.request(); this.changed();
    }
    clearPalette() { this.palette = {}; this.modeEnabled = false; this.hazardEnabled = false; this.doorEnabled = false; this.save(); this.request(); this.changed(); }
    setModeEnabled(on) {
        if (on && !this.paletteReady()) throw new Error('Learn Blue, Red, Green and Orange first');
        this.modeEnabled = !!on; this.save(); this.request(); this.changed();
    }
    hazardReady() { return !!(this.hazardLearn.off && this.hazardLearn.on && this.hazardLearn.off !== this.hazardLearn.on); }
    learnHazard(which) {
        if (which !== 'off' && which !== 'on') throw new Error('Unknown hazard learning state');
        if (!this.hazardRaw) throw new Error('No LampExterior2 special-flashing value has been received');
        this.hazardLearn[which] = this.hazardRaw; this.save(); this.recomputeHazard();
        this.notice = this.message('Hazards {state} signal learned', { state: this.translate(which.toUpperCase()) });
        this.changed();
    }
    setHazardEnabled(on) {
        if (on && !this.palette.ORANGE) throw new Error('Learn Orange first');
        if (on && !this.hazardReady()) throw new Error('Learn hazards OFF and ON first');
        this.hazardEnabled = !!on; this.save(); this.request(); this.changed();
    }
    setDoorEnabled(on) {
        if (on && !this.palette.RED) throw new Error('Learn Red first');
        if (on && !this.doorProvider) throw new Error('Door provider is not configured yet; run the connected-car signal profile step');
        this.doorEnabled = !!on; this.save(); this.request(); this.changed();
    }
    receiveMode(raw) { const before = this.mode; this.mode = D.drivingMode(raw); if (before !== this.mode) this.request(); this.changed(); }
    receiveLight(raw) {
        this.color = D.reportedColor(raw); this.lightState = raw && raw.statusModeAmbientePanoramicRoofInteriorLighting;
        if (!this.activeAlert() && !this.busy && this.color !== null) this.lastNormalColor = this.color;
        this.changed();
    }
    receiveEngine(raw) { const v = D.engineRunning(raw); if (v !== this.engine) { this.engine = v; this.request(); } this.changed(); }
    receiveLamp(raw) { this.hazardRaw = D.hazardSignature(raw); this.recomputeHazard(); this.changed(); }
    recomputeHazard() {
        const old = this.hazard;
        this.hazard = !this.hazardReady() || !this.hazardRaw ? null : this.hazardRaw === this.hazardLearn.on ? true : this.hazardRaw === this.hazardLearn.off ? false : null;
        if (old !== this.hazard) this.request();
    }
    // Hook for the exact door provider added after the connected-car catalog pass.
    receiveDoor(open) { this.doorProvider = true; const v = typeof open === 'boolean' ? open : null; if (v !== this.door) { this.door = v; this.request(); } this.changed(); }
    activeAlert() {
        if (this.doorEnabled && this.doorProvider && this.engine === true && this.door === true && this.palette.RED) return { key: 'door', label: 'Door open with engine running', value: this.palette.RED };
        if (this.hazardEnabled && this.hazard === true && this.palette.ORANGE) return { key: 'hazard', label: 'Hazards', value: this.palette.ORANGE };
        return null;
    }
    baseColor() {
        const semantic = this.mode && D.MODE_COLOURS[this.mode.name];
        return this.modeEnabled && semantic ? this.palette[semantic] : (this.alertRestore !== null ? this.alertRestore : this.lastNormalColor);
    }
    desired() {
        const alert = this.activeAlert();
        if (alert) return { value: this.flashOn ? alert.value : this.baseColor(), why: alert.label + (this.flashOn ? ' pulse' : ' restore phase'), alert: alert.key };
        const semantic = this.mode && D.MODE_COLOURS[this.mode.name];
        if (this.modeEnabled && semantic && this.palette[semantic]) return { value: this.palette[semantic], why: this.mode.label + ' -> ' + semantic, alert: null };
        if (this.alertRestore !== null) return { value: this.alertRestore, why: 'restore colour after alert', alert: null };
        return null;
    }
    request() {
        const alert = this.activeAlert();
        if (alert && this.alertRestore === null) this.alertRestore = this.color !== null ? this.color : this.lastNormalColor;
        this.pending = true;
        this.drain().catch((e) => { this.notice = e.message; this.ctx.log.warn(e); this.changed(); });
    }
    offered(key) { const c = this.connections[key]; return !!(c && c.available && c.ready && !this.closed); }
    async drain() {
        if (this.busy || this.closed) return;
        this.busy = true;
        try {
            while (this.pending && !this.closed) {
                this.pending = false;
                const wanted = this.desired();
                if (!wanted || this.ctx.preview || !this.offered('light')) continue;
                if (wanted.value === null || wanted.value === undefined || wanted.value === this.color) {
                    if (!wanted.alert && this.alertRestore !== null) this.alertRestore = null;
                    continue;
                }
                const wait = MIN_WRITE_MS - (Date.now() - this.lastWriteAt);
                if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
                if (this.closed) continue;
                const current = this.desired();
                if (!current || current.value !== wanted.value || current.why !== wanted.why) { this.pending = true; continue; }
                const c = this.connections.light;
                try {
                    await this.ctx.signals.set(c.proxy, 'ambientLightInteriorColour', D.colorRequest(wanted.value), 2500);
                    this.lastWriteAt = Date.now(); this.lastWrite = wanted.why + ' (slot ' + wanted.value + ')';
                    const raw = await c.proxy.getValue('statusAmbientLightInteriorColour', 2000);
                    this.receiveLight(raw);
                    if (!wanted.alert && this.alertRestore !== null) this.alertRestore = null;
                } catch (e) { this.lastWrite = wanted.why + ' failed: ' + e.message; this.ctx.log.warn('ambient write: ' + e.message); }
            }
        } finally { this.busy = false; this.changed(); }
    }
    async open(key, iface, field, receive, notificationOnly) {
        const c = { key, proxy: null, available: false, ready: false };
        this.connections[key] = c;
        try {
            c.proxy = await this.ctx.signals.proxy(iface, '1');
            await this.ctx.signals.onAvailable(c.proxy, (a) => { c.available = a; if (a && c.ready && !notificationOnly) this.read(c, field, receive); this.changed(); });
            await this.ctx.signals.on(c.proxy, field, receive, this.ctx.log);
            c.ready = true;
            if (c.available && !notificationOnly) await this.read(c, field, receive);
        } catch (e) { c.error = e.message; this.ctx.log.warn(iface + '.' + field + ': ' + e.message); this.changed(); }
    }
    async read(c, field, receive) { try { receive(await c.proxy.getValue(field, 2000)); } catch (e) { this.ctx.log.warn(field + ': ' + e.message); } }
    async start() {
        if (this.ctx.preview || !this.ctx.signals || typeof this.ctx.signals.hasNative !== 'function' ||
            !this.ctx.signals.hasNative()) { this.changed(); return; }
        await Promise.all([
            this.open('mode', D.FES, 'statusFESVehicleDynamicSwitchHMI', (v) => this.receiveMode(v)),
            this.open('light', D.LIGHT, 'statusAmbientLightInteriorColour', (v) => this.receiveLight(v)),
            this.open('engine', D.CDS, 'statusEngineStatus', (v) => this.receiveEngine(v)),
            this.open('hazard', D.BODY_LIGHT, 'LampExterior2', (v) => this.receiveLamp(v), true)
        ]);
        this.poll = setInterval(() => {
            [['mode', 'statusFESVehicleDynamicSwitchHMI', (v) => this.receiveMode(v)],
             ['light', 'statusAmbientLightInteriorColour', (v) => this.receiveLight(v)],
             ['engine', 'statusEngineStatus', (v) => this.receiveEngine(v)]].forEach((x) => { const c = this.connections[x[0]]; if (c && c.available && c.ready) this.read(c, x[1], x[2]); });
        }, 2500);
        this.flash = setInterval(() => { if (!this.activeAlert()) { this.flashOn = true; return; } this.flashOn = !this.flashOn; this.request(); this.changed(); }, FLASH_MS);
        this.request();
    }
    status() {
        if (this.notice) return this.notice;
        const alert = this.activeAlert();
        if (alert) return this.message('{alert} alert active; {phase} phase', {
            alert: this.translate(alert.label), phase: this.translate(this.flashOn ? 'alert colour' : 'normal colour')
        });
        if (!this.paletteReady()) return 'Learn the four physical colours; no automatic writes are enabled';
        if (!this.modeEnabled) return 'Drive-mode colours disabled; vehicle lighting is unchanged';
        if (!this.mode) return 'Enabled; waiting for the current driving mode';
        const semantic = D.MODE_COLOURS[this.mode.name];
        const mode = this.translate(this.mode.label);
        return semantic ? this.message('{mode} follows {colour}', {
            mode, colour: this.translate(semantic[0] + semantic.slice(1).toLowerCase())
        }) : this.message('{mode} is intentionally left unchanged', { mode });
    }
    close() {
        if (this.closed) return; this.closed = true; clearInterval(this.poll); clearInterval(this.flash);
        Object.keys(this.connections).forEach((k) => { const p = this.connections[k].proxy; if (p && p.shutdown) Promise.resolve(p.shutdown()).catch(() => {}); });
    }
}
module.exports = { Controller, MIN_WRITE_MS, FLASH_MS };
