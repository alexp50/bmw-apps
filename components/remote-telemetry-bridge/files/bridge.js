#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');
const child = require('child_process');
const url = require('url');

const ROOT = '/var/opt/remote-telemetry-bridge';
const CONFIG = path.join(ROOT, 'config.json');
const SOMEIP_DIR = path.join(ROOT, 'someip');
const RUN = '/run/remote-telemetry-bridge';
const STATUS = path.join(RUN, 'status.json');
const LAST_STATUS = path.join(ROOT, 'last-status.json');
const RETAINED = path.join(ROOT, 'retained-telemetry.json');
const LEASE = '/run/mgu-uplink/lease.json';
const FALLBACK_UID = 65534;
const SIGNAL_APP = 'vehicle_health';
const OAP_UIDS = '/var/opt/public/oap/oap_12201/security/uids.txt';
const UPLINK_UID_FILE = '/var/opt/mgu-uplink/uids.d/remote-telemetry-bridge';
// The paid relay plan permits the 30-second cadence used by the in-car
// assistant. State changes still upload immediately through scheduleUpload().
const INTERVAL_MS = 30000;
const DIAGNOSTIC_INTERVAL_MS = 30000;
const COMMAND_INTERVAL_MS = 5000;

const retained = readJson(RETAINED, {});
const state = {
    startedAt: new Date().toISOString(), lastSampleAt: retained.sampledAt || null, lastUploadAt: null,
    lastHttpStatus: null, error: null, configured: false, uplink: false,
    providers: {}, telemetry: retained.telemetry || {}, climate: retained.climate || {}, awake: true, phase: 'starting', signalUid: null,
    batteryVoltageSource: retained.batteryVoltageSource || null,
    insideTemperatureSource: retained.insideTemperatureSource || null,
    insideTemperatureSampledAt: retained.insideTemperatureSampledAt || null,
    outsideTemperatureSource: retained.outsideTemperatureSource || null,
    outsideTemperatureSampledAt: retained.outsideTemperatureSampledAt || null,
    assistant: retained.assistant || {
        schema:1, warmup:null, trip:{current:null,recent:[]},
        health:{}, service:{items:[],summary:null}, checkControl:{active:0,items:[]}, connection:{}
    }
};
state.assistant.schema = 1;
state.assistant.health = state.assistant.health || {};
state.assistant.trip = state.assistant.trip || {current:null,recent:[]};
state.assistant.trip.recent = Array.isArray(state.assistant.trip.recent) ? state.assistant.trip.recent : [];
state.assistant.service = state.assistant.service || {items:[],summary:null};
state.assistant.service.items = Array.isArray(state.assistant.service.items) ? state.assistant.service.items : [];
state.assistant.checkControl = state.assistant.checkControl || {active:0,items:[]};
state.assistant.connection = state.assistant.connection || {};
let stopping = false;
const proxies = [];
let runtimeConfig = {};
let climateProxy = null;
let seatClimateProxy = null;
let commandBusy = false;
let uploadTimer = null;
let requestIhkaStatus = () => {};
let diagnosticProxy = null;
let ihkaStatusBusy = false;
let assistantLastTick = Date.now();
let assistantLastUpload = 0;

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function atomicJson(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n');
    fs.renameSync(tmp, file);
}
function writeStatus() {
    try { atomicJson(STATUS, state); } catch (e) {}
    try { atomicJson(LAST_STATUS, state); } catch (e) {}
    const slow = {};
    if (finite(state.telemetry.batteryVoltage)) slow.batteryVoltage = state.telemetry.batteryVoltage;
    if (finite(state.telemetry.outsideTemperatureC)) slow.outsideTemperatureC = state.telemetry.outsideTemperatureC;
    try { atomicJson(RETAINED, {
        sampledAt: state.lastSampleAt, telemetry: slow, climate: state.climate,
        batteryVoltageSource: state.batteryVoltageSource,
        outsideTemperatureSource: state.outsideTemperatureSource,
        outsideTemperatureSampledAt: state.outsideTemperatureSampledAt,
        assistant: state.assistant
    }); } catch (e) {}
}
function finite(v) { return typeof v === 'number' && isFinite(v); }
function temp(raw) { return finite(raw) && raw !== 255 ? Math.round((raw * 0.5 - 40) * 10) / 10 : null; }
function speed(raw) { return finite(raw) && raw !== 65535 ? Math.round(raw * 0.015625 * 10) / 10 : null; }
function pressure(raw) { return finite(raw) && raw < 65532 ? Math.round(raw) / 10 : null; }
function round(v, n) { const p = Math.pow(10, n || 0); return Math.round(v * p) / p; }
function walk(v, fn) {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, fn));
    fn(v); Object.keys(v).forEach((k) => walk(v[k], fn));
}
function findObject(v, key) { let got = null; walk(v, (o) => { if (!got && Object.prototype.hasOwnProperty.call(o, key)) got = o; }); return got; }
function cleanText(v) { return String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120); }
function oilLevel(v) {
    return ({MOTOROELSTAND_UNTER_MINIMUM:'Below minimum',MOTOROELSTAND_AM_MINIMUM:'At minimum',MOTOROELSTAND_1_4:'1/4',
        MOTOROELSTAND_2_4:'2/4',MOTOROELSTAND_3_4:'3/4',MOTOROELSTAND_4_4:'Full',MOTOROELSTAND_5_4:'Above full',
        MOTOROELSTAND_UEBERFUELLT:'Overfilled',MOTOROELSTAND_OK:'OK',SERVICEFUNKTION_AKTIV:'Measuring',
        0:'Below minimum',1:'At minimum',2:'1/4',3:'2/4',4:'3/4',5:'Full',6:'Above full',7:'Overfilled',13:'OK',14:'Measuring'})[v] || null;
}
function blowerLevel(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 27) return undefined;
    if (value === 0) return 0;
    // O18 reports the nine manual blower stages as calibrated airflow values
    // 3, 6, ... 27 rather than returning the STUFE enum that was requested.
    return Math.max(1, Math.min(9, Math.round(value / 3)));
}
function targetTemperature(raw) {
    return finite(raw) && raw >= 32 && raw <= 56 ? raw / 2 : undefined;
}
function enumState(raw, on, off) {
    if (raw === on) return true;
    if (raw === off) return false;
    return undefined;
}
function setInsideDegrees(value, source) {
    if (!finite(value) || value < -40 || value > 80) return;
    const sampledAt = new Date().toISOString();
    const degrees = Math.round(value * 10) / 10;
    const changed = state.telemetry.insideTemperatureC !== degrees ||
        state.telemetry.insideTemperatureSampledAt !== sampledAt ||
        state.telemetry.insideTemperatureSource !== source;
    state.telemetry.insideTemperatureC = degrees;
    state.telemetry.insideTemperatureSampledAt = sampledAt;
    state.telemetry.insideTemperatureSource = source;
    state.insideTemperatureSource = source;
    state.insideTemperatureSampledAt = sampledAt;
    state.lastSampleAt = sampledAt;
    if (changed) { writeStatus(); scheduleUpload(); }
}
function bytes(value) {
    if (!value) return [];
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) return Array.prototype.slice.call(value);
    if (value.data) return bytes(value.data);
    if (typeof value === 'object' && typeof value.length === 'number') return Array.prototype.slice.call(value);
    return [];
}

function setTelemetry(name, value) {
    if (value === null || value === undefined) return;
    if (JSON.stringify(state.telemetry[name]) === JSON.stringify(value)) return;
    state.telemetry[name] = value;
    state.lastSampleAt = new Date().toISOString();
    writeStatus();
    scheduleUpload();
}

function scheduleUpload() {
    if (uploadTimer || !runtimeConfig.endpoint) return;
    uploadTimer = setTimeout(() => {
        uploadTimer = null;
        if (!stopping) upload(runtimeConfig).catch(() => {});
    }, 800);
}

function updateClimate(patch) {
    let changed = false;
    for (const name of Object.keys(patch)) {
        if (patch[name] !== undefined && state.climate[name] !== patch[name]) {
            state.climate[name] = patch[name];
            changed = true;
        }
    }
    if (!changed) return;
    state.climate.sampledAt = new Date().toISOString();
    state.lastSampleAt = state.climate.sampledAt;
    writeStatus();
    scheduleUpload();
}

function setOutsideDegrees(degrees, source, preferred) {
    if (!finite(degrees) || degrees < -50 || degrees > 80) return;
    // Once the cluster-filtered signal has arrived, never replace it with a
    // diagnostic or raw-sensor fallback.
    if (!preferred && state.outsideTemperatureSource === 'EnvironmentalInformation.ExteriorTemperature') return;
    setTelemetry('outsideTemperatureC', Math.round(degrees * 10) / 10);
    state.outsideTemperatureSource = source;
    state.outsideTemperatureSampledAt = new Date().toISOString();
    writeStatus();
}

function ensureSomeIp() {
    // v12 adds assistant health, service and Check Control fields. Component upgrades keep this
    // generated directory, so the marker must change when the manifest does.
    const marker = path.join(SOMEIP_DIR, '.bridge-config-v12');
    if (fs.existsSync(marker)) return;
    if (!fs.existsSync(SOMEIP_DIR)) fs.mkdirSync(SOMEIP_DIR);
    try {
        child.execFileSync('/usr/bin/node', [path.join(__dirname, 'generate-someip.js'), SOMEIP_DIR], {stdio:'inherit'});
        fs.writeFileSync(marker, new Date().toISOString() + '\n');
    } catch (e) {
        state.error = 'SOME/IP configuration: ' + e.message;
        writeStatus();
    }
}

function configureDns() {
    const lease = readJson(LEASE, {});
    const leaseServers = Array.isArray(lease.dns) ? lease.dns.filter((x) => typeof x === 'string' && x) : [];
    // The Huawei router occasionally refuses a query while its LTE session is
    // renegotiating. Public resolvers remain reachable through the same
    // uid-routed mgu-uplink path and keep command polling alive in that window.
    const servers = Array.from(new Set(['1.1.1.1', '8.8.8.8'].concat(leaseServers)));
    dns.setServers(servers);
    state.uplink = !!lease.interface;
}

function resolveSignalUid() {
    try {
        const lines = fs.readFileSync(OAP_UIDS, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const match = /^(\d+)=(.+)$/.exec(line.trim());
            if (match && match[2] === SIGNAL_APP) return Number(match[1]);
        }
    } catch (e) {}
    return FALLBACK_UID;
}

function allowUplinkUid(uid) {
    try {
        fs.writeFileSync(UPLINK_UID_FILE, String(FALLBACK_UID) + '\n' + String(uid) + '\n');
    } catch (e) {
        state.error = 'cannot register uplink uid: ' + e.message;
    }
}

// https.request uses the OS resolver (dns.lookup), which on this MGU is the
// vehicle dnsmasq instance. When ENET and the Wi-Fi uplink share a subnet,
// that resolver can send its upstream query over the vehicle route. Resolve
// inside this uid-routed process instead; mgu-uplink then carries both DNS
// and HTTPS through the selected Internet adapter.
function uplinkLookup(hostname, options, callback) {
    dns.resolve4(hostname, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses || !addresses.length) return callback(new Error('DNS returned no IPv4 address for ' + hostname));
        callback(null, addresses[0], 4);
    });
}

function loadSomeIp() {
    try { return require('someip'); } catch (globalError) {
        try { return require('/usr/lib/someip.node'); } catch (directError) {
            throw new Error('SOME/IP native module unavailable: ' + globalError.message + '; ' + directError.message);
        }
    }
}

function configFile(iface) { return path.join(SOMEIP_DIR, iface.replace(/\./g, '_') + '.json'); }
let nativeChain = Promise.resolve();
function nativeTick(fn) {
    const run = () => new Promise((resolve, reject) => setImmediate(() => {
        try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); }
    }));
    const result = nativeChain.then(run, run);
    nativeChain = result.catch(() => {});
    return result;
}
function watch(someip, iface, field, receive) {
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(configFile(iface), 'utf8'));
    } catch (e) {
        state.providers[iface] = false;
        state.error = iface + ': no generated interface configuration';
        writeStatus();
        return Promise.resolve(null);
    }
    return nativeTick(() => someip.buildProxy(cfg, '1').then((proxy) => proxy.init().then(() => proxy))).then((proxy) => {
        proxies.push(proxy);
        state.providers[iface] = false;
        proxy.subscribeToAvailability((available) => {
            state.providers[iface] = !!available;
            if (available && cfg.fields && cfg.fields[field] && cfg.fields[field].getter) {
                proxy.getValue(field, 3000).then(receive).catch(() => {});
            }
            writeStatus();
        });
        try { proxy.subscribe({name:field, onReceive:receive}).catch(() => {}); } catch (e) {}
        setInterval(() => {
            if (state.providers[iface] && cfg.fields && cfg.fields[field] && cfg.fields[field].getter) {
                proxy.getValue(field, 3000).then(receive).catch(() => {});
            }
        }, 15000);
        return proxy;
    }).catch((e) => { state.providers[iface] = false; state.error = iface + ': ' + e.message; writeStatus(); return null; });
}

function watchClimate(someip) {
    const iface = 'de.bmw.infotainment.climate.Climate2';
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configFile(iface), 'utf8')); }
    catch (e) { state.providers[iface] = false; state.error = iface + ': no generated interface configuration'; writeStatus(); return Promise.resolve(null); }
    return nativeTick(() => someip.buildProxy(cfg, '1').then((proxy) => proxy.init().then(() => proxy))).then((proxy) => {
        proxies.push(proxy); climateProxy = proxy; state.providers[iface] = false;
        // The firmware catalog declares this member only as an unscaled UInt8.
        // Do not guess a conversion here. IHKA D8D7 below is the documented,
        // signed undamped cabin sensor and is the only numeric cabin source.
        const receive = (value) => {
            const raw = value && value.temperatureInside;
            if (finite(raw) && raw !== 255) state.climate.temperatureInsideRaw = raw;
        };
        const remember = (name) => (value) => {
            if (!state.climate) state.climate = {};
            state.climate[name] = value;
            state.climate.sampledAt = new Date().toISOString();
            writeStatus();
            if (name === 'frontFunctions' && value) updateClimate({
                on:enumState(value.statusAC, 'KLIMAANLAGE_EIN', 'KLIMAANLAGE_AUS'),
                frontDefrost:enumState(value.statusDefrost, 'DEFROST_EIN', 'DEFROST_AUS'),
                recirculation:{
                    AUC_AUSSCHALTEN__S__UMLUFT_S_AUC_AUS:'fresh',
                    AUC_EINSCHALTEN__S__AUC_EIN:'auto',
                    S__UMLUFT_EIN:'recirculate'
                }[value.statusAUCFront]
            });
            if (name === 'driver' && value) updateClimate({
                driverTargetC:targetTemperature(value.temperatureTargetDRIHKA),
                fanDriver:blowerLevel(value.statusBlowerSettingDR),
                autoDriver:enumState(value.statusBlowerAutomaticDR, 'GEBLAESEAUTOMATIK_EIN', 'GEBLAESEAUTOMATIK_AUS')
            });
            if (name === 'passenger' && value) updateClimate({
                passengerTargetC:targetTemperature(value.temperatureTargetPSIHKA),
                fanPassenger:blowerLevel(value.statusBlowerSettingPS),
                autoPassenger:enumState(value.statusBlowerAutomaticPS, 'GEBLAESEAUTOMATIK_EIN', 'GEBLAESEAUTOMATIK_AUS')
            });
            if (name === 'park' && value) {
                const heating = value.statusParkHeater === 'STANDHEIZUNG_EIN';
                const ventilation = value.statusIndependentVentilate === 'STANDLUEFTEN_EIN';
                const airConditioning = value.statusParkAirConditioning === 'STANDKLIMATISIERUNG_EIN';
                const auto = value.statusParkFunctionAutoMode === 'AUTO_MINUS_MODUS_EIN';
                const active = heating || ventilation || airConditioning || auto || value.statusBlower === 'GEBLAESE_EIN';
                const known = [
                    value.statusParkHeater, value.statusIndependentVentilate,
                    value.statusParkAirConditioning, value.statusParkFunctionAutoMode,
                    value.statusBlower
                ].some((item) => typeof item === 'string' && item !== 'SIGNAL_UNGUELTIG' && item.indexOf('NICHT_VERFUEGBAR') < 0);
                if (!known) return;
                updateClimate({
                    preconditioning:active,
                    preconditioningMode:heating ? 'heating' : ventilation ? 'ventilation' : airConditioning ? 'airConditioning' : auto ? 'auto' : 'off',
                    operatingMode:active ? 'preconditioning' : (state.climate.engineRunning ? 'driving' : 'parked'),
                    on:active ? true : (state.climate.engineRunning === false ? false : undefined)
                });
            }
            if (name === 'preconditioning' && value) updateClimate({
                preconditioningCompressorReleased:finite(value.releasePreconditioningParkAirConditioning) ? value.releasePreconditioningParkAirConditioning : undefined
            });
        };
        proxy.subscribeToAvailability((available) => {
            state.providers[iface] = !!available;
            if (available) {
                proxy.getValue('statusTemperatureInside', 3000).then(receive).catch(() => {});
                proxy.getValue('statusACFrontFunctions', 3000).then(remember('frontFunctions')).catch(() => {});
                proxy.getValue('statusAirConditionDRStatus', 3000).then(remember('driver')).catch(() => {});
                proxy.getValue('statusAirConditionPSStatus', 3000).then(remember('passenger')).catch(() => {});
                proxy.getValue('statusAirConditionParkFunctions', 3000).then(remember('park')).catch(() => {});
                proxy.getValue('statusPreconditioningParkAirConditioning', 3000).then(remember('preconditioning')).catch(() => {});
            }
            writeStatus();
        });
        try { proxy.subscribe({name:'statusTemperatureInside', onReceive:receive}).catch(() => {}); } catch (e) {}
        for (const pair of [
            ['statusACFrontFunctions','frontFunctions'],
            ['statusAirConditionDRStatus','driver'],
            ['statusAirConditionPSStatus','passenger'],
            ['statusAirConditionParkFunctions','park'],
            ['statusPreconditioningParkAirConditioning','preconditioning']
        ]) {
            try { proxy.subscribe({name:pair[0], onReceive:remember(pair[1])}).catch(() => {}); } catch (e) {}
        }
        setInterval(() => { if (state.providers[iface]) proxy.getValue('statusTemperatureInside', 3000).then(receive).catch(() => {}); }, 15000);
        return proxy;
    }).catch((e) => { state.providers[iface] = false; state.error = iface + ': ' + e.message; writeStatus(); return null; });
}

function seatLevel(value, name) {
    const raw = value && value[name];
    if (finite(raw)) return raw >= 0 && raw <= 3 ? raw : undefined;
    const match = /^STUFE_([0-3])$/.exec(String(raw || ''));
    return match ? Number(match[1]) : undefined;
}

function openSeatClimate(someip) {
    const iface = 'de.bmw.infotainment.climate.Climate';
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configFile(iface), 'utf8')); }
    catch (e) { state.providers[iface] = false; writeStatus(); return Promise.resolve(null); }
    return nativeTick(() => someip.buildProxy(cfg, '1').then((proxy) => proxy.init().then(() => proxy))).catch(() => null);
}

function watchSeatClimate(someip, openedProxy) {
    const iface = 'de.bmw.infotainment.climate.Climate';
    const ready = openedProxy ? Promise.resolve(openedProxy) : openSeatClimate(someip);
    return ready.then((proxy) => {
        if (!proxy) { state.providers[iface] = false; writeStatus(); return null; }
        proxies.push(proxy); seatClimateProxy = proxy; state.providers[iface] = false;
        const fields = {
            statusSeatHeatingDR:['driverHeat','statusSeatHeaterDR'],
            statusSeatHeatingPS:['passengerHeat','statusSeatHeaterPS'],
            statusSeatHeatingDRR:['rearLeftHeat','statusSeatHeaterDRR'],
            statusSeatHeatingPSR:['rearRightHeat','statusSeatHeaterPSR'],
            statusSeatClimateDR:['driverVent','statusSeatClimateDR'],
            statusSeatClimatePS:['passengerVent','statusSeatClimatePS'],
            statusSeatClimateDRR:['rearLeftVent','statusSeatClimateDRR'],
            statusSeatClimatePSR:['rearRightVent','statusSeatClimatePSR']
        };
        const receive = (field) => (value) => {
            const pair = fields[field];
            const level = seatLevel(value, pair[1]);
            if (level !== undefined) updateClimate({[pair[0]]:level});
        };
        const receiveAux = (field) => (value) => {
            if (!value) return;
            if (field === 'statusACFront') updateClimate({sync:enumState(value.statusSync, 'SYNC_AN', 'SYNC_AUS')});
            if (field === 'statusACFond2') {
                const rearAuto = value.statusModeAirConditioning2Tier === 'EIN';
                updateClimate({
                    autoRearLeft:rearAuto, autoRearRight:rearAuto,
                    rearLeftTargetC:targetTemperature(value.statusTemperatureTarget2TierDR),
                    rearRightTargetC:targetTemperature(value.statusTemperatureTarget2TierPS),
                    fanRear:blowerLevel(value.statusBlowerSettingAirConditioning2Tier)
                });
            }
        };
        const auxFields = ['statusACFront','statusACFond2'];
        const refresh = () => {
            if (!state.providers[iface]) return;
            for (const field of Object.keys(fields)) proxy.getValue(field, 3000).then(receive(field)).catch(() => {});
            for (const field of auxFields) proxy.getValue(field, 3000).then(receiveAux(field)).catch(() => {});
        };
        proxy.subscribeToAvailability((available) => {
            state.providers[iface] = !!available;
            if (available) refresh();
            writeStatus();
        });
        for (const field of Object.keys(fields)) {
            try { proxy.subscribe({name:field, onReceive:receive(field)}).catch(() => {}); } catch (e) {}
        }
        for (const field of auxFields) {
            try { proxy.subscribe({name:field, onReceive:receiveAux(field)}).catch(() => {}); } catch (e) {}
        }
        setInterval(refresh, 5000);
        return proxy;
    }).catch((e) => { state.providers[iface] = false; writeStatus(); return null; });
}

function parkClimateValue(on) {
    return {
        operationParkHeat:'KEINE_AKTION__S__NICHT_VERFUEGBAR',
        operationIndependentVentilate:'KEINE_AKTION__S__NICHT_VERFUEGBAR',
        operationExtraHeater:'KEINE_AKTION__S__NICHT_VERFUEGBAR',
        operationParkAirConditioning:'KEINE_AKTION__S__NICHT_VERFUEGBAR',
        // Auto mode lets IHKA select Webasto heat or parked ventilation from
        // ambient/cabin temperature instead of forcing the electric A/C path.
        operationParkFunctionAutoMode:on ? 'AUTO_MINUS_MODUS_EIN' : 'AUTO_MINUS_MODUS_AUS',
        operationRemoteStart:'KEINE_AKTION_NICHT_VERFUEGBAR'
    };
}

function frontClimateValue(command) {
    const no = 'KEINE_AUSWAHL';
    const value = {
        operationOnDR:no, operationOnPS:no, operationAircon:no,
        operationModeAirConditioningDR:no, operationModeAirConditioningPS:no,
        operationTemperatureTargetDR:255, operationTemperatureTargetPS:255,
        operationIntensityDR:no, operationIntensityPS:no, requestAICPIA:'KEINE_ANFORDERUNG',
        operationDefrost:no, operationMaximumAirCondition:no,
        operationManualBlowerLevelDR:no, operationManualBlowerLevelPS:no,
        operationAirdistributionProgramDR:no, operationAirdistributionProgramPS:no
    };
    if (command.type === 'climate_on' || command.type === 'climate_off') {
        value.operationOnDR = command.type === 'climate_on' ? 'EIN' : 'AUS';
        value.operationOnPS = value.operationOnDR;
    }
    if (command.type === 'defrost_on' || command.type === 'defrost_off') value.operationDefrost = command.type === 'defrost_on' ? 'EIN' : 'AUS';
    if (command.type === 'set_temperature') {
        value.operationTemperatureTargetDR = Math.round(command.celsius * 2);
        value.operationTemperatureTargetPS = Math.round(command.celsius * 2);
    }
    if (command.type === 'set_fan') {
        value.operationManualBlowerLevelDR = 'STUFE_' + command.level;
        value.operationManualBlowerLevelPS = 'STUFE_' + command.level;
    }
    if (command.type === 'manual_fan_mode') {
        value.operationModeAirConditioningDR = 'AUS';
        value.operationModeAirConditioningPS = 'AUS';
    }
    if (command.type === 'set_auto') {
        const wanted = command.enabled ? 'EIN' : 'AUS';
        if (command.zone === 'driver') value.operationModeAirConditioningDR = wanted;
        if (command.zone === 'frontPassenger') value.operationModeAirConditioningPS = wanted;
    }
    return value;
}

function specialClimateValue(command) {
    const value = {
        operationScentSelectionSmell:'KEINE_AUSWAHL',
        controlScentIntensity:'KEINE_AKTION',
        operationAUCFront:'KEINE_AUSWAHL',
        operationScent:'KEINE_AUSWAHL',
        operationSync:'KEINE_AUSWAHL'
    };
    if (command.type === 'set_sync') value.operationSync = command.enabled ? 'SYNCH_AN' : 'SYNCH_AUS';
    if (command.type === 'set_recirculation') value.operationAUCFront = {
        fresh:'FRISCHLUFT_GEWAEHLT', auto:'AUC_GEWAEHLT', recirculate:'UMLUFT_GEWAEHLT'
    }[command.mode];
    return value;
}

function rearClimateValue(command) {
    return {
        operationAirconRearCompartment:'SIGNAL_UNGUELTIG',
        operationAirConditioningDefault2Tier:'KEINE_AUSWAHL',
        operationAirConditioningDefault3Tier:'KEINE_AUSWAHL',
        operationOn2Tier:'KEINE_AUSWAHL', operationOn3Tier:'KEINE_AUSWAHL',
        operationModeAirConditioning2Tier:command.enabled ? 'EIN' : 'AUS',
        operationModeAirConditioning3Tier:'KEINE_AUSWAHL',
        operationLock2Tier:'KEINE_AUSWAHL', operationLock3Tier:'KEINE_AUSWAHL',
        operationAircon3Tier:'KEINE_AUSWAHL',
        operationBlowerSettingAirConditionings2Tier:'KEINE_AUSWAHL',
        operationBlowerSettingAirConditionings3Tier:'KEINE_AUSWAHL',
        operationTemperatureTarget2TierDR:255, operationTemperatureTarget2TierPS:255,
        operationTemperatureTarget3Tier:255,
        operationAirDistributionProgramClimate3Seat:'KEINE_AUSWAHL',
        operationAirDistributionProgramClimate2Seat:'KEINE_AUSWAHL',
        operationManualBlowerLevelClimate3SeatRow:'KEINE_AUSWAHL',
        operationManualBlowerLevelClimate2SeatRow:'KEINE_AUSWAHL'
    };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitClimate(field, check, timeout) {
    const until = Date.now() + (timeout || 5000);
    let last = null;
    while (Date.now() < until) {
        try {
            last = await nativeTick(() => climateProxy.getValue(field, 3000));
            if (check(last)) return last;
        } catch (e) {}
        await sleep(350);
    }
    throw new Error('BMW Climate2 did not confirm the requested state' + (last ? ': ' + JSON.stringify(last) : ''));
}

async function waitSeatClimate(field, check, timeout) {
    const until = Date.now() + (timeout || 5000);
    let last = null;
    while (Date.now() < until) {
        try {
            last = await nativeTick(() => seatClimateProxy.getValue(field, 3000));
            if (check(last)) return last;
        } catch (e) {}
        await sleep(350);
    }
    throw new Error('BMW IHKA did not confirm the requested state' + (last ? ': ' + JSON.stringify(last) : ''));
}

function seatClimateValue(command) {
    const value = {
        operationStratificationSeatHeaterDR:31, operationStratificationSeatHeaterPS:31,
        operationStratificationSeatHeaterDRR:31, operationStratificationSeatHeaterPSR:31,
        operationFunctionStageSeatHeaterDR:4, operationFunctionStageSeatClimateDR:4,
        operationFunctionStageSeatHeaterPS:4, operationFunctionStageSeatClimatePS:4,
        operationFunctionStageSeatHeaterDRR:4, operationFunctionStageSeatClimateDRR:4,
        operationFunctionStageSeatHeaterPSR:4, operationFunctionStageSeatClimatePSR:4,
        operationFunctionStageNeckHeaterDR:'KEINE_AKTION', operationFunctionStageNeckHeaterPS:'KEINE_AKTION',
        operationFunctionNeckHeaterDR:'KEINE_AKTION', operationFunctionNeckHeaterPS:'KEINE_AKTION'
    };
    const suffix = {driver:'DR', frontPassenger:'PS', rearLeft:'DRR', rearRight:'PSR'}[command.seat];
    const kind = command.type === 'seat_heat' ? 'Heater' : 'Climate';
    value['operationFunctionStageSeat' + kind + suffix] = command.level;
    return value;
}

function seatDirectValue(command) {
    const value = {
        oPStratificationSeatHeaterAICDriver:31,
        oPStratificationSeatHeaterAICPassenger:31,
        oPStratificationSeatHeaterAICDriverRear:31,
        oPStratificationSeatHeaterAICPassengerRear:31,
        oPFunctionStageSeatHeaterAICDriver:'KEINE_AKTION',
        oPFunctionStageSeatClimateAICDriver:'KEINE_AKTION',
        oPFunctionStageSeatHeaterAICPassenger:'KEINE_AKTION',
        oPFunctionStageSeatClimateAICPassenger:'KEINE_AKTION',
        oPFunctionStageSeatHeaterAICDriverRear:'KEINE_AKTION',
        oPFunctionStageSeatClimateAICDriverRear:'KEINE_AKTION',
        oPFunctionStageSeatHeaterAICPassengerRear:'KEINE_AKTION',
        oPFunctionStageSeatClimateAICPassengerRear:'KEINE_AKTION',
        oPFunctionStageNeckHeaterAICDriver:'KEINE_AKTION',
        oPFunctionStageNeckHeaterAICPassenger:'KEINE_AKTION',
        oPFunctionNeckHeaterAICDriver:'KEINE_AKTION',
        oPFunctionNeckHeaterAICPassenger:'KEINE_AKTION',
        operationSeatHeaterAIC3Tier:'KEINE_AKTION'
    };
    const seat = {driver:'Driver',frontPassenger:'Passenger',rearLeft:'DriverRear',rearRight:'PassengerRear'}[command.seat];
    const kind = command.type === 'seat_heat' ? 'Heater' : 'Climate';
    value['oPFunctionStageSeat' + kind + 'AIC' + seat] = 'STUFE_' + command.level;
    return value;
}

async function executeCommand(command) {
    const seatCommand = command.type === 'seat_heat' || command.type === 'seat_vent';
    const legacyClimateCommand = command.type === 'set_sync' || command.type === 'set_recirculation' ||
        (command.type === 'set_auto' && (command.zone === 'rearLeft' || command.zone === 'rearRight'));
    if (seatCommand) {
        if (!climateProxy || !state.providers['de.bmw.infotainment.climate.Climate2'] ||
            !seatClimateProxy || !state.providers['de.bmw.infotainment.climate.Climate']) {
            throw new Error('BMW seat-climate command or status provider is unavailable');
        }
    } else if (legacyClimateCommand) {
        if (!seatClimateProxy || !state.providers['de.bmw.infotainment.climate.Climate']) throw new Error('BMW seat-climate provider is unavailable');
    } else if (!climateProxy || !state.providers['de.bmw.infotainment.climate.Climate2']) throw new Error('BMW Climate2 provider is unavailable');
    if (command.type === 'set_recirculation' && (!climateProxy || !state.providers['de.bmw.infotainment.climate.Climate2'])) {
        throw new Error('BMW Climate2 status provider is unavailable');
    }
    let field, value, description, targetProxy = climateProxy;
    if ((command.type === 'climate_on' || command.type === 'climate_off') &&
        (state.climate.engineRunning === false || state.climate.preconditioning === true)) {
        field = 'airConditionParkFunctions'; value = parkClimateValue(command.type === 'climate_on'); description = 'parked climate ' + (command.type === 'climate_on' ? 'on' : 'off');
    } else if (command.type === 'climate_on' || command.type === 'climate_off' || command.type === 'defrost_on' || command.type === 'defrost_off' || command.type === 'set_temperature' || command.type === 'set_fan' || (command.type === 'set_auto' && (command.zone === 'driver' || command.zone === 'frontPassenger'))) {
        field = 'operationAirConditioningFront'; value = frontClimateValue(command); description = command.type.replace(/_/g, ' ');
    } else if (command.type === 'seat_heat' || command.type === 'seat_vent') {
        field = 'operationStratificationSeatHeating'; value = seatClimateValue(command); targetProxy = climateProxy;
        description = command.type.replace(/_/g, ' ') + ' ' + command.seat + ' level ' + command.level;
    } else if (command.type === 'set_sync' || command.type === 'set_recirculation') {
        field = 'acSpecialFunction'; value = specialClimateValue(command); targetProxy = seatClimateProxy;
        description = command.type.replace(/_/g, ' ');
    } else if (command.type === 'set_auto' && (command.zone === 'rearLeft' || command.zone === 'rearRight')) {
        field = 'acFond'; value = rearClimateValue(command); targetProxy = seatClimateProxy;
        description = 'rear auto ' + (command.enabled ? 'on' : 'off');
    } else if (command.type === 'rear_defrost_on' || command.type === 'rear_defrost_off') {
        if (!diagnosticProxy) throw new Error('BMW IHKA diagnostic provider is unavailable');
        const wanted = command.type === 'rear_defrost_on';
        requestIhkaStatus();
        for (let i = 0; i < 12 && state.climate.rearDefrost === undefined; i++) await sleep(250);
        if (state.climate.rearDefrost === wanted) return 'rear defrost already ' + (wanted ? 'on' : 'off');
        // BMW IHKA routine A126 simulates the physical climate-panel button.
        // Button 0x02 is HHS (Heckscheibenheizung / rear-window heating).
        // Send a short press and release, then verify the authoritative D8DB
        // function-status byte rather than assuming the toggle succeeded.
        for (const pressed of [1, 0]) {
            await nativeTick(() => diagnosticProxy.callMethod('sendTasuRequest', {
                sourceAddress:0xF2, targetAddress:0x78, serviceID:0x31, subroutineID:0x01,
                udsDataLength:4, udsData:Buffer.from([0xA1, 0x26, 0x02, pressed]), deadlockTime:0
            }, 5000));
            await sleep(pressed ? 250 : 100);
        }
        const until = Date.now() + 10000;
        while (Date.now() < until) {
            requestIhkaStatus();
            if (state.climate.rearDefrost === wanted) return 'rear defrost confirmed ' + (wanted ? 'on' : 'off');
            await sleep(400);
        }
        throw new Error('IHKA did not confirm rear-window heating ' + (wanted ? 'on' : 'off'));
    } else throw new Error('Unsupported command type');
    if (command.type === 'set_fan' && state.climate.on !== true && state.climate.preconditioning !== true) {
        // O18 ignores a manual blower stage when it is bundled with the
        // transition from off to on. Start the front climate first, wait for
        // its authoritative status, then issue the manual stage below.
        await nativeTick(() => climateProxy.setValue(field, frontClimateValue({type:'climate_on'}), 6000));
        await waitClimate('statusACFrontFunctions', (v) => v && v.statusAC === 'KLIMAANLAGE_EIN', 8000);
    }
    if (command.type === 'set_fan' && (!state.climate.driver || state.climate.driver.statusBlowerAutomaticDR !== 'GEBLAESEAUTOMATIK_AUS')) {
        await nativeTick(() => climateProxy.setValue(field, frontClimateValue({type:'manual_fan_mode'}), 6000));
        await waitClimate('statusAirConditionDRStatus', (v) => v && v.statusBlowerAutomaticDR === 'GEBLAESEAUTOMATIK_AUS', 8000);
    }
    await nativeTick(() => targetProxy.setValue(field, value, 6000));
    if (command.type === 'climate_on' || command.type === 'climate_off') {
        if (field === 'airConditionParkFunctions') {
            const on = command.type === 'climate_on';
            const wanted = on ? 'AUTO_MINUS_MODUS_EIN' : 'AUTO_MINUS_MODUS_AUS';
            try {
                const confirmed = await waitClimate('statusAirConditionParkFunctions', (v) =>
                    v && v.statusParkFunctionAutoMode === wanted, 7000);
                updateClimate({preconditioning:on, preconditioningMode:on ? 'auto' : 'off', operatingMode:on ? 'preconditioning' : 'parked', on});
                return description + ' confirmed: ' + confirmed.statusParkFunctionAutoMode;
            } catch (parkError) {
                // O18 refuses parked-climate setters while the car is awake in
                // accessory/diagnostic mode. Preserve the front-climate
                // control that works in that state, and report which path BMW
                // actually confirmed instead of claiming Webasto activation.
                await nativeTick(() => climateProxy.setValue('operationAirConditioningFront', frontClimateValue(command), 6000));
                const frontWanted = on ? 'KLIMAANLAGE_EIN' : 'KLIMAANLAGE_AUS';
                const confirmed = await waitClimate('statusACFrontFunctions', (v) => v && v.statusAC === frontWanted, 8000);
                updateClimate({preconditioning:false, preconditioningMode:'off', operatingMode:state.climate.engineRunning ? 'driving' : 'parked', on});
                return 'front climate confirmed after parked climate was unavailable: ' + confirmed.statusAC;
            }
        }
        const wanted = command.type === 'climate_on' ? 'KLIMAANLAGE_EIN' : 'KLIMAANLAGE_AUS';
        const confirmed = await waitClimate('statusACFrontFunctions', (v) => v && v.statusAC === wanted);
        return description + ' confirmed: ' + confirmed.statusAC;
    }
    if (command.type === 'defrost_on' || command.type === 'defrost_off') {
        const wanted = command.type === 'defrost_on' ? 'DEFROST_EIN' : 'DEFROST_AUS';
        const confirmed = await waitClimate('statusACFrontFunctions', (v) => v && v.statusDefrost === wanted);
        return description + ' confirmed: ' + confirmed.statusDefrost;
    }
    if (command.type === 'set_temperature') {
        const raw = Math.round(command.celsius * 2);
        const confirmed = await waitClimate('statusAirConditionDRStatus', (v) => v && v.temperatureTargetDRIHKA === raw);
        return description + ' confirmed: ' + (confirmed.temperatureTargetDRIHKA / 2).toFixed(1) + ' C';
    }
    if (command.type === 'set_fan') {
        const confirmed = await waitClimate('statusAirConditionDRStatus', (v) => v && blowerLevel(v.statusBlowerSettingDR) === command.level, 8000);
        updateClimate({fanDriver:blowerLevel(confirmed.statusBlowerSettingDR)});
        return description + ' confirmed: level ' + command.level;
    }
    if (command.type === 'set_auto') {
        if (command.zone === 'driver') {
            const confirmed = await waitClimate('statusAirConditionDRStatus', (v) => v && (v.statusBlowerAutomaticDR === 'GEBLAESEAUTOMATIK_EIN') === command.enabled, 8000);
            updateClimate({autoDriver:confirmed.statusBlowerAutomaticDR === 'GEBLAESEAUTOMATIK_EIN'});
            return 'driver auto confirmed ' + (command.enabled ? 'on' : 'off');
        }
        if (command.zone === 'frontPassenger') {
            const confirmed = await waitClimate('statusAirConditionPSStatus', (v) => v && (v.statusBlowerAutomaticPS === 'GEBLAESEAUTOMATIK_EIN') === command.enabled, 8000);
            updateClimate({autoPassenger:confirmed.statusBlowerAutomaticPS === 'GEBLAESEAUTOMATIK_EIN'});
            return 'front passenger auto confirmed ' + (command.enabled ? 'on' : 'off');
        }
        const confirmed = await waitSeatClimate('statusACFond2', (v) => v && (v.statusModeAirConditioning2Tier === 'EIN') === command.enabled, 8000);
        const enabled = confirmed.statusModeAirConditioning2Tier === 'EIN';
        updateClimate({autoRearLeft:enabled, autoRearRight:enabled});
        return 'rear auto confirmed ' + (enabled ? 'on' : 'off');
    }
    if (command.type === 'set_sync') {
        const confirmed = await waitSeatClimate('statusACFront', (v) => v && (v.statusSync === 'SYNC_AN') === command.enabled, 8000);
        updateClimate({sync:confirmed.statusSync === 'SYNC_AN'});
        return 'sync confirmed ' + (command.enabled ? 'on' : 'off');
    }
    if (command.type === 'set_recirculation') {
        const wanted = {fresh:'AUC_AUSSCHALTEN__S__UMLUFT_S_AUC_AUS',auto:'AUC_EINSCHALTEN__S__AUC_EIN',recirculate:'S__UMLUFT_EIN'}[command.mode];
        const confirmed = await waitClimate('statusACFrontFunctions', (v) => v && v.statusAUCFront === wanted, 8000);
        updateClimate({recirculation:command.mode});
        return 'recirculation confirmed: ' + command.mode;
    }
    if (command.type === 'seat_heat' || command.type === 'seat_vent') {
        if (!seatClimateProxy || !state.providers['de.bmw.infotainment.climate.Climate']) throw new Error('BMW seat-climate provider is unavailable');
        const key = {
            driver:{seat_heat:'driverHeat',seat_vent:'driverVent'},
            frontPassenger:{seat_heat:'passengerHeat',seat_vent:'passengerVent'},
            rearLeft:{seat_heat:'rearLeftHeat',seat_vent:'rearLeftVent'},
            rearRight:{seat_heat:'rearRightHeat',seat_vent:'rearRightVent'}
        }[command.seat][command.type];
        const field = {
            driver:{seat_heat:'statusSeatHeatingDR',seat_vent:'statusSeatClimateDR'},
            frontPassenger:{seat_heat:'statusSeatHeatingPS',seat_vent:'statusSeatClimatePS'},
            rearLeft:{seat_heat:'statusSeatHeatingDRR',seat_vent:'statusSeatClimateDRR'},
            rearRight:{seat_heat:'statusSeatHeatingPSR',seat_vent:'statusSeatClimatePSR'}
        }[command.seat][command.type];
        const member = {
            statusSeatHeatingDR:'statusSeatHeaterDR',statusSeatHeatingPS:'statusSeatHeaterPS',
            statusSeatHeatingDRR:'statusSeatHeaterDRR',statusSeatHeatingPSR:'statusSeatHeaterPSR',
            statusSeatClimateDR:'statusSeatClimateDR',statusSeatClimatePS:'statusSeatClimatePS',
            statusSeatClimateDRR:'statusSeatClimateDRR',statusSeatClimatePSR:'statusSeatClimatePSR'
        }[field];
        const until = Date.now() + 12000;
        while (Date.now() < until) {
            try {
                const current = await nativeTick(() => seatClimateProxy.getValue(field, 3000));
                const level = seatLevel(current, member);
                if (level !== undefined) updateClimate({[key]:level});
                if (level === command.level) return description + ' confirmed';
            } catch (e) {}
            await sleep(350);
        }
        throw new Error('IHKA did not confirm ' + description);
    }
    return description + ' confirmed';
}

function relayRequest(config, method, pathName, body) {
    return new Promise((resolve, reject) => {
        const target = url.parse(config.endpoint.replace(/\/$/, '') + '/v1/cars/' + encodeURIComponent(config.carId) + pathName);
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const headers = {'Authorization':'Bearer ' + config.writeToken, 'Accept':'application/json', 'User-Agent':'BMW-MGU-Remote-Telemetry/0.2'};
        if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
        const req = https.request({protocol:'https:', hostname:target.hostname, port:target.port || 443, path:target.path, method, timeout:10000, lookup:uplinkLookup, headers}, (res) => {
            const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch (e) {}
                resolve({status:res.statusCode, body:parsed});
            });
        });
        req.on('timeout', () => req.destroy(new Error('relay timeout'))); req.on('error', reject);
        if (payload) req.write(payload); req.end();
    });
}

async function pollCommand(config) {
    if (commandBusy || !config.endpoint || !config.writeToken || !config.carId) return;
    commandBusy = true;
    try {
        configureDns();
        const response = await relayRequest(config, 'GET', '/commands', null);
        state.commandError = null;
        writeStatus();
        if (response.status === 204) return;
        if (response.status !== 200 || !response.body || !response.body.id) throw new Error('command relay HTTP ' + response.status);
        const command = response.body;
        let status = 'accepted', result;
        try { result = await executeCommand(command); } catch (e) { status = 'rejected'; result = e.message; }
        let acknowledgement = null;
        for (let attempt = 0; attempt < 8; attempt++) {
            acknowledgement = await relayRequest(config, 'POST', '/commands/' + encodeURIComponent(command.id), {status, result});
            if (acknowledgement.status === 200) break;
            await sleep(750);
        }
        if (!acknowledgement || acknowledgement.status !== 200) {
            throw new Error('command acknowledgement HTTP ' + (acknowledgement ? acknowledgement.status : 'unavailable'));
        }
        state.lastCommand = {id:command.id, type:command.type, status, result, completedAt:new Date().toISOString()};
        writeStatus();
    } catch (e) { state.commandError = e.message; writeStatus(); }
    finally { commandBusy = false; }
}

// DDE DID 43C1 is the IBS-measured 12 V system voltage in millivolts. DDE DID
// 50A6 is the environment temperature as uint16 * 0.1 - 273.14 C. The
// request is read-only UDS 22 over BMW's TASU service, the same transport used
// by the diagnostic apps on the head unit. BMW's filtered exterior broadcast
// remains authoritative whenever it is available.
function watchBatteryVoltage(someip) {
    const iface = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configFile(iface), 'utf8')); }
    catch (e) { state.providers.batteryVoltage = false; state.error = 'battery voltage: no TASU configuration'; writeStatus(); return Promise.resolve(null); }
    return nativeTick(() => someip.buildProxy(cfg, 'SystemFunctionsInternalTasuInst1').then((proxy) => proxy.init().then(() => proxy))).then((proxy) => {
        proxies.push(proxy);
        diagnosticProxy = proxy;
        let available = !!(proxy.isAvailable && proxy.isAvailable());
        state.providers.batteryVoltage = available;
        try { proxy.subscribeToAvailability((value) => { available = !!value; state.providers.batteryVoltage = available; writeStatus(); }); } catch (e) {}
        proxy.subscribe({name:'sendTasuResponse', onReceive:(value) => {
            const frame = bytes(value && (value.udsResponse !== undefined ? value.udsResponse : value));
            if (frame.length < 13) return;
            const targetAddress = frame[6];
            const uds = frame.slice(9);
            if (uds[0] !== 0x62) return;
            if (targetAddress === 0x78) {
                const did = (uds[1] << 8) | uds[2];
                const data = uds.slice(3);
                if (did === 0xD8D7 && data.length >= 11) {
                    const raw = data[10];
                    if (raw !== 0x80) setInsideDegrees(raw > 127 ? raw - 256 : raw, 'IHKA D8D7 undamped cabin sensor');
                } else if (did === 0xD8DB && data.length >= 28) {
                    updateClimate({
                        // Climate/Climate2 provide the authoritative live
                        // front, fan and seat states. D8DB is retained only
                        // for rear-window heating, which has no SOME/IP field
                        // on this firmware.
                        rearDefrost:data[5] === 1 || data[5] === 2
                    });
                }
                return;
            }
            if (targetAddress !== 0x12) return;
            for (let i = 1; i + 1 < uds.length;) {
                const did = (uds[i] << 8) | uds[i + 1]; i += 2;
                if (did === 0x43C1 && i + 1 < uds.length) {
                    const voltage = ((uds[i] << 8) | uds[i + 1]) * 0.001; i += 2;
                    if (voltage >= 6 && voltage <= 18) {
                        setTelemetry('batteryVoltage', Math.round(voltage * 100) / 100);
                        state.batteryVoltageSource = 'DDE 43C1 · IBS measured';
                    }
                } else if (did === 0x50A6 && i + 1 < uds.length) {
                    const outside = ((uds[i] << 8) | uds[i + 1]) * 0.1 - 273.14; i += 2;
                    setOutsideDegrees(outside, 'DDE 50A6 · environment temperature', false);
                } else break;
            }
        }}).catch(() => {});
        const request = () => {
            if (!available) return;
            nativeTick(() => proxy.callMethod('sendTasuRequest', {
                sourceAddress:0xF2, targetAddress:0x12, serviceID:0x22, subroutineID:0,
                udsDataLength:4, udsData:Buffer.from([0x43, 0xC1, 0x50, 0xA6]), deadlockTime:0
            }, 5000)).catch((e) => { state.error = 'battery voltage: ' + e.message; writeStatus(); });
        };
        requestIhkaStatus = async () => {
            if (!available || ihkaStatusBusy) return;
            ihkaStatusBusy = true;
            try {
                for (const did of [[0xD8, 0xD7], [0xD8, 0xDB]]) {
                    await nativeTick(() => proxy.callMethod('sendTasuRequest', {
                        sourceAddress:0xF2, targetAddress:0x78, serviceID:0x22, subroutineID:0,
                        udsDataLength:2, udsData:Buffer.from(did), deadlockTime:0
                    }, 5000));
                    // TASU acknowledges the request before the ECU response is
                    // broadcast. Avoid presenting the IHKA with two overlapping
                    // ReadDataByIdentifier requests.
                    await sleep(250);
                }
            } catch (e) {
                state.error = 'IHKA status: ' + e.message; writeStatus();
            } finally { ihkaStatusBusy = false; }
        };
        request(); setInterval(request, DIAGNOSTIC_INTERVAL_MS);
        requestIhkaStatus(); setInterval(requestIhkaStatus, 5000);
        return proxy;
    }).catch((e) => { state.providers.batteryVoltage = false; state.error = 'battery voltage: ' + e.message; writeStatus(); return null; });
}

function assistantEngineState(running) {
    const now = Date.now(), a = state.assistant, trip = a.trip || (a.trip = {current:null,recent:[]});
    if (running === true && !trip.current) {
        trip.current = {id:String(now), startedAt:new Date(now).toISOString(), stoppedAt:null,
            durationSeconds:0, distanceKm:0, topSpeedKmh:0, tankStartLitres:a.health.tankLitres == null ? null : a.health.tankLitres,
            tankEndLitres:null};
        a.warmup = {startedAt:new Date(now).toISOString(), startCoolantC:a.health.coolantC == null ? null : a.health.coolantC,
            progressPercent:0, estimatedMinutesRemaining:null, estimatedKmRemaining:null, safeRpm:1500, active:true};
        assistantLastUpload = 0;
    }
    if (trip.current) {
        if (running === true) trip.current.stoppedAt = null;
        else if (!trip.current.stoppedAt) trip.current.stoppedAt = new Date(now).toISOString();
    }
}

function assistantTick() {
    const now = Date.now(), dt = Math.max(0, Math.min(10, (now - assistantLastTick) / 1000));
    assistantLastTick = now;
    const a = state.assistant, health = a.health || (a.health = {}), trip = a.trip || (a.trip = {current:null,recent:[]});
    const current = trip.current, running = state.climate.engineRunning === true, speedKmh = finite(state.telemetry.speedKmh) ? state.telemetry.speedKmh : 0;
    if (current) {
        current.durationSeconds = Math.max(0, Math.round((now - Date.parse(current.startedAt)) / 1000));
        if (running) {
            current.distanceKm = round((current.distanceKm || 0) + speedKmh * dt / 3600, 3);
            current.topSpeedKmh = round(Math.max(current.topSpeedKmh || 0, speedKmh), 1);
            current.tankEndLitres = health.tankLitres == null ? current.tankEndLitres : health.tankLitres;
        }
        if (!running && current.stoppedAt && now - Date.parse(current.stoppedAt) >= 10 * 60000) {
            current.endedAt = current.stoppedAt;
            current.durationSeconds = Math.max(0, Math.round((Date.parse(current.endedAt) - Date.parse(current.startedAt)) / 1000));
            current.fuelUsedLitres = finite(current.tankStartLitres) && finite(current.tankEndLitres) ? round(Math.max(0, current.tankStartLitres - current.tankEndLitres), 1) : null;
            if (current.distanceKm >= 0.1 || current.durationSeconds >= 60) {
                trip.recent = (trip.recent || []).filter((x) => x.id !== current.id).concat([current]).slice(-20);
            }
            trip.current = null;
        }
    }
    if (a.warmup && running) {
        const elapsedMin = Math.max(0, (now - Date.parse(a.warmup.startedAt)) / 60000);
        const coolant = health.coolantC;
        const start = finite(a.warmup.startCoolantC) ? a.warmup.startCoolantC : (finite(coolant) ? coolant : 20);
        const target = 80;
        const progress = finite(coolant) ? Math.max(0, Math.min(1, (coolant - start) / Math.max(1, target - start))) : 0;
        const rate = finite(coolant) && elapsedMin >= 0.5 ? Math.max(0, (coolant - start) / elapsedMin) : 0;
        const remainMin = rate > 0.4 && coolant < target ? Math.min(45, Math.max(0, (target - coolant) / rate)) : coolant >= target ? 0 : null;
        const movingSpeed = current && current.durationSeconds > 20 ? current.distanceKm / (current.durationSeconds / 3600) : speedKmh;
        a.warmup.progressPercent = Math.round(progress * 100);
        a.warmup.estimatedMinutesRemaining = remainMin == null ? null : round(remainMin, 1);
        a.warmup.estimatedKmRemaining = remainMin == null || movingSpeed < 2 ? null : round(movingSpeed * remainMin / 60, 1);
        a.warmup.safeRpm = Math.round((1500 + progress * 1000) / 50) * 50;
        a.warmup.active = coolant == null || coolant < target;
        if (coolant >= target) a.warmup.completedAt = a.warmup.completedAt || new Date(now).toISOString();
    } else if (a.warmup) a.warmup.active = false;
    a.connection = {
        bridgeVersion:'0.3.0', phase:state.phase, configured:state.configured, uplink:state.uplink,
        providersReady:Object.keys(state.providers).filter((k) => state.providers[k]).length,
        providersTotal:Object.keys(state.providers).length, lastUploadAt:state.lastUploadAt
    };
    a.sampledAt = new Date(now).toISOString();
    if (now - assistantLastUpload >= 30000) { assistantLastUpload = now; writeStatus(); scheduleUpload(); }
}

function upload(config) {
    configureDns();
    if (!config.endpoint || !config.writeToken || !config.carId) {
        state.configured = false; state.error = 'not configured'; writeStatus(); return Promise.resolve(false);
    }
    state.configured = true;
    const target = url.parse(config.endpoint.replace(/\/$/, '') + '/v1/cars/' + encodeURIComponent(config.carId) + '/telemetry');
    if (target.protocol !== 'https:') {
        state.error = 'endpoint must use HTTPS'; writeStatus(); return Promise.resolve(false);
    }
    const payload = Buffer.from(JSON.stringify({
        schema:1, sampledAt:state.lastSampleAt, awake:state.awake !== false,
        telemetry:state.telemetry, climate:state.climate, assistant:state.assistant
    }));
    return new Promise((resolve) => {
        const req = https.request({
            protocol:'https:', hostname:target.hostname, port:target.port || 443,
            path:target.path, method:'POST', timeout:12000, lookup:uplinkLookup,
            headers:{'Authorization':'Bearer ' + config.writeToken, 'Content-Type':'application/json',
                'Content-Length':payload.length, 'User-Agent':'BMW-MGU-Remote-Telemetry/0.1'}
        }, (res) => {
            res.resume(); state.lastHttpStatus = res.statusCode;
            if (res.statusCode >= 200 && res.statusCode < 300) {
                state.lastUploadAt = new Date().toISOString(); state.error = null; resolve(true);
            } else { state.error = 'relay returned HTTP ' + res.statusCode; resolve(false); }
            writeStatus();
        });
        req.on('timeout', () => req.destroy(new Error('upload timeout')));
        req.on('error', (e) => { state.error = e.message; writeStatus(); resolve(false); });
        req.end(payload);
    });
}

async function main() {
    if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT);
    if (!fs.existsSync(RUN)) fs.mkdirSync(RUN);
    writeStatus();
    runtimeConfig = readJson(CONFIG, {});
    ensureSomeIp();
    const signalUid = resolveSignalUid();
    state.signalUid = signalUid;
    allowUplinkUid(signalUid);
    try { fs.chownSync(RUN, signalUid, signalUid); } catch (e) {}
    const someip = loadSomeIp();
    // This older O18 image exposes the direct seat Climate interface to a
    // privileged client, while the newer Climate2 interface follows the OAP
    // app grant. Open only the seat proxy before dropping privileges; the
    // established SOME/IP client remains usable after the process becomes the
    // Vehicle Health app UID. All HTTP, files and the remaining vehicle
    // interfaces therefore continue to run without root privileges.
    const openedSeatClimate = await openSeatClimate(someip);
    const setOutside = (value, source, filtered) => {
        const raw = value && (filtered ? value.temperatureExterior : value.unfilteredTemperatureExterior);
        const degrees = temp(raw);
        if (degrees === null) return;
        setOutsideDegrees(degrees, 'EnvironmentalInformation.' + source, filtered);
    };
    // BMW's SOME/IP ACL is keyed to an installed OAP application's uid. Use
    // Vehicle Health's signal grant, and grant that same uid outbound access
    // through mgu-uplink for the authenticated relay only.
    if (process.getuid && process.getuid() === 0) {
        try { process.setgid(signalUid); process.setuid(signalUid); } catch (e) { throw new Error('cannot drop privileges: ' + e.message); }
    }
    writeStatus();
    await Promise.all([
        watchClimate(someip),
        watchSeatClimate(someip, openedSeatClimate),
        watch(someip, 'de.bmw.infrastructure.EnvironmentalInformation', 'ExteriorTemperature',
            (v) => setOutside(v, 'ExteriorTemperature', true)),
        watch(someip, 'de.bmw.infrastructure.EnvironmentalInformation', 'unfilteredExteriorTemperature',
            (v) => setOutside(v, 'unfilteredExteriorTemperature', false)),
        watch(someip, 'de.bmw.infotainment.vehicle.CDS', 'statusBattery2',
            (v) => {
                const value = v && v.conditionBatteryChargingCondition;
                if (finite(value) && value >= 0 && value <= 100) setTelemetry('batteryChargePercent', value);
            }),
        watch(someip, 'de.bmw.infotainment.vehicle.CDS', 'statusEngineStatus', (v) => {
            const running = enumState(v && v.statusEngineRunDrive, 'MOTOR_LAEUFT', 'MOTOR_AUS');
            updateClimate({
                engineRunning:running,
                operatingMode:running === true ? 'driving' : state.climate.preconditioning ? 'preconditioning' : running === false ? 'parked' : undefined
            });
            assistantEngineState(running);
        }),
        watch(someip, 'de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', (v) => {
            const coolant = temp(v && v.temperatureEngineDrive), oil = temp(v && v.temperatureEngineOilDrive);
            if (coolant !== null) state.assistant.health.coolantC = coolant;
            if (oil !== null) state.assistant.health.oilTemperatureC = oil;
        }),
        watch(someip, 'de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2',
            (v) => setTelemetry('speedKmh', speed(v && v.speedVehicleCentreOfGravity))),
        watch(someip, 'de.bmw.infotainment.vehicle.Vehicle2', 'statusOilDipstick2', (v) => {
            const level = oilLevel(v && v.fluidLevelEngineOilRelative);
            if (level) state.assistant.health.oilLevel = level;
        }),
        watch(someip, 'de.bmw.infotainment.vehicle.TPMS', 'statusTyrePressure', (v) => {
            if (!v) return;
            setTelemetry('tyrePressureBar', {
                frontLeft:pressure(v.actualValuePressureTyreFLH), frontRight:pressure(v.actualValuePressureTyreFRH),
                rearLeft:pressure(v.actualValuePressureTyreRLH), rearRight:pressure(v.actualValuePressureTyreRRH)
            });
        }),
        watch(someip, 'de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', (v) => {
            if (finite(v && v.fluidLevelFuelTank) && v.fluidLevelFuelTank < 255) state.assistant.health.tankLitres = v.fluidLevelFuelTank;
            if (finite(v && v.range) && v.range < 4095) state.assistant.health.rangeKm = v.range;
        }),
        watch(someip, 'de.bmw.infotainment.KombiInterface_2', 'cbsDataServiceList', (v) => {
            const list = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
            state.assistant.service.items = list.map((entry) => {
                const s = findObject(entry, 'cBSIdentifier') || {};
                return {id:s.cBSIdentifier == null ? null : String(s.cBSIdentifier), name:cleanText(s.cBSServcieName || s.cBSServiceName),
                    distance:cleanText(s.cBSServiceWay), date:cleanText(s.cBSServiceDate), color:finite(s.cBSColor) ? s.cBSColor : null};
            }).filter((x) => x.name).slice(0, 20);
        }),
        watch(someip, 'de.bmw.infotainment.KombiInterface_2', 'cbsDataSBA', (v) => {
            const s = findObject(v, 'cBSDataSBAText') || {};
            state.assistant.service.summary = {name:cleanText(s.cBSDataSBAText), distance:cleanText(s.cBSDataSBADistance), date:cleanText(s.cBSDataSBADate)};
        }),
        watch(someip, 'de.bmw.infotainment.checkcontrol.CheckControlMaster', 'basicList', (v) => {
            const items = [];
            walk(v, (o) => {
                if (o.ccmId === undefined) return;
                const active = o.activeState === 'AKTIV' || o.activeState === 0;
                if (active && !items.some((x) => x.id === o.ccmId)) items.push({id:o.ccmId, ecu:o.requestorDiagAddr, reason:cleanText(o.reason)});
            });
            state.assistant.checkControl = {active:items.length, items:items.slice(0, 20)};
        }),
        watchBatteryVoltage(someip)
    ]);
    state.phase = 'running';
    if (Object.keys(state.providers).length) state.error = null;
    writeStatus();
    const tick = () => { if (!stopping) upload(runtimeConfig).catch(() => {}); };
    tick(); setInterval(tick, INTERVAL_MS);
    const commandTick = () => { if (!stopping) pollCommand(runtimeConfig).catch(() => {}); };
    commandTick(); setInterval(commandTick, COMMAND_INTERVAL_MS);
    assistantTick(); setInterval(assistantTick, 1000);
    // At cold boot oapcontroller can be active before its SOME/IP providers
    // are published. Re-enter through systemd once instead of remaining in a
    // permanently disconnected state until the next manual restart.
    setTimeout(() => {
        if (!stopping && !state.providers['de.bmw.infotainment.climate.Climate2'] &&
            !state.providers['de.bmw.infotainment.vehicle.CDS']) process.exit(75);
    }, 30000);
}

function stop() {
    if (stopping) return; stopping = true;
    state.awake = false; writeStatus();
    upload(runtimeConfig).catch(() => {}).then(() => Promise.all(proxies.map((p) => p.shutdown ? p.shutdown().catch(() => {}) : null)))
        .then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
main().catch((e) => { state.phase = 'failed'; state.error = e.message; writeStatus(); process.stderr.write('remote telemetry: ' + e.stack + '\n'); process.exit(1); });
