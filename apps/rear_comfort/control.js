'use strict';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (value) => {
    if (typeof value === 'number') return value >= 0 && value <= 3 ? value : 0;
    const m = /STUFE_(\d)/.exec(String(value || ''));
    return m ? Number(m[1]) : 0;
};
const blowerStage = (value) => {
    if (typeof value === 'number') return value >= 1 && value <= 9 ? value : null;
    const m = /STUFE_(\d)/.exec(String(value || ''));
    return m ? Number(m[1]) : null;
};
const active = (value) => {
    const text = String(value || '').toUpperCase();
    if (/KEINE|SIGNAL|NICHT|INAKTIV|AUS|OFF|FALSE/.test(text)) return false;
    return /(^|_)EIN($|_)|AKTIV|ACTIVE|USER_ON|FULL_ON|TRUE/.test(text);
};
const rearTemperature = (value) => {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw === 255) return null;
    const celsius = raw / 2;
    return celsius >= 16 && celsius <= 32 ? celsius : null;
};

class RearControl {
    constructor(signals, log, changed) {
        this.signals = signals; this.log = log; this.changed = changed || (() => {});
        this.p = {}; this.subs = []; this.busy = false; this.seatAlive = 0;
        this.haveACFond2 = false;
        this.seatCancelToken = 0; this.activeSeatRequests = new Set();
        this.state = {
            climate: { left: null, right: null, blower: null, auto: null, on: null, lock: null, sync: null },
            left: { heat: 0, vent: 0, massage: 0, program: 1 },
            right: { heat: 0, vent: 0, massage: 0, program: 1 },
            memory: { side: null, status: 'Waiting for BMW seat memory', requestor: null },
            seatMotion: { active: false, label: 'Ready', step: '' },
            seatModes: { lounge: null, visibility: null },
            shades: { left: null, right: null, rear: null },
            screens: { left: null, right: null, focus: 'NO_RSE_SELECTION', display: null,
                brightness: null, volume: null, ready: null, remote: null, apps: [] },
            available: {}
        };
    }
    touch() { this.changed(this.state); }
    async watch(name, iface, instance, handlers, pollMs) {
        const sub = await this.signals.watch(iface, instance, handlers, this.log, { pollMs: pollMs || 1500 });
        this.subs.push(sub); this.p[name] = sub.proxy; this.state.available[name] = !!sub.available;
        if (sub.proxy) this.signals.onAvailable(sub.proxy, (yes) => {
            this.state.available[name] = yes; this.touch();
        }).catch(() => {});
        return sub;
    }
    async init() {
        await this.watch('climate', 'de.bmw.infotainment.climate.Climate', '1', {
            statusClimateFond: (v) => {
                if (this.haveACFond2) return;
                this.state.climate.left = Number(v.statusDisplayTemperatureLeftHandAirConditioningRearCompartment);
                this.state.climate.right = Number(v.statusDisplayTemperatureRightHandAirConditioningRearCompartment);
                this.state.climate.blower = blowerStage(v.statusDisplayBlowerSettingAirConditioningRearCompartment);
                this.state.climate.auto = String(v.statusDisplayModeAirConditioningRearCompartment) === 'AUTOMATIK'; this.touch();
            },
            statusACFond2: (v) => {
                this.haveACFond2 = true;
                const tier3 = active(v.statusOn3Tier) || active(v.statusModeAirConditioning3Tier);
                const left = rearTemperature(v.statusTemperatureTarget2TierDR);
                const right = rearTemperature(v.statusTemperatureTarget2TierPS);
                const shared = rearTemperature(v.statusTemperatureTarget3Tier);
                this.state.climate.left = left === null ? shared : left;
                this.state.climate.right = right === null ? shared : right;
                this.state.climate.on = tier3 || active(v.statusOn2Tier) || active(v.statusModeAirConditioning2Tier);
                this.state.climate.lock = active(tier3 ? v.statusLock3Tier : v.statusLock2Tier);
                this.state.climate.auto = active(tier3 ? v.statusModeAirConditioning3Tier : v.statusModeAirConditioning2Tier);
                this.state.climate.blower = blowerStage(tier3 ? v.statusManualBlowerLevel3RowOfSeats : v.statusManualBlowerLevel2RowOfSeats);
                this.touch();
            },
            statusACFront: (v) => {
                this.state.climate.sync = String(v.statusSync || '') === 'SYNC_AN'; this.touch();
            },
            statusSeatHeatingDRR: (v) => { this.state.left.heat = stage(v.statusSeatHeaterDRR); this.touch(); },
            statusSeatHeatingPSR: (v) => { this.state.right.heat = stage(v.statusSeatHeaterPSR); this.touch(); },
            statusSeatClimateDRR: (v) => { this.state.left.vent = stage(v.statusSeatClimateDRR); this.touch(); },
            statusSeatClimatePSR: (v) => { this.state.right.vent = stage(v.statusSeatClimatePSR); this.touch(); }
        });
        await this.watch('comfort', 'de.bmw.infotainment.misc.ComfortFunctionIuK', '1', {
            statusSeatMassageRL: (v) => {
                this.state.left.massage = stage(v.statusIntensityPneumaticSeatRLH);
                const p = Number(String(v.statusProgramPneumaticSeatRLH || '').replace('PROGRAMM_', ''));
                this.state.left.program = p >= 1 && p <= 4 ? p : 1; this.touch();
            },
            statusSeatMassageRR: (v) => {
                this.state.right.massage = stage(v.statusIntensityPneumaticSeatRRH);
                const p = Number(String(v.statusProgramPneumaticSeatRRH || '').replace('PROGRAMM_', ''));
                this.state.right.program = p >= 1 && p <= 4 ? p : 1; this.touch();
            },
            statusAdjustmentLumbarRL: () => this.touch(),
            statusAdjustmentLumbarRR: () => this.touch()
        });
        await this.watch('shades', 'de.bmw.infotainment.vehicle.A4A', '1', {
            statusSunblind: (v) => {
                this.state.shades.left = v.statusEngineRLHSunBlind;
                this.state.shades.right = v.statusEngineRRHSunBlind;
                this.state.shades.rear = v.statusEngineRearSunBlind; this.touch();
            }
        });
        await this.watch('seat', 'com.harman.infotainment.systeminfrastructure.seatcommandproxy.seatcommandproxy.SeatCommandProxyCtrl', 'Inst1', {
            seatProxySeatOperationStatus: () => this.touch()
        });
        await this.watch('lifecycle', 'de.bmw.infotainment.lifecycle.lifecycle.Lifecycle', 'Front', {
            rseHmiMenu: () => {}, rseLock: () => {}, rseLowPowerMode: () => {}, theatreMode: () => {}
        }, 3000);
        await this.watch('rseLife', 'de.bmw.infotainment.lifecycle.lifecyclerse.LifecycleRSE', 'Rear', {
            focusIndicatorHMI: (v) => { this.state.screens.focus = v; this.touch(); },
            powerStateDetailedLeft: (v) => { this.state.screens.left = v; this.touch(); },
            powerStateDetailedRight: (v) => { this.state.screens.right = v; this.touch(); }
        }, 2500);
        await this.watch('rseApps', 'de.bmw.infotainment.rseapplicationcontrol.RSEApplicationControl', '3', {
            launchableApps: (v) => { this.state.screens.apps = Array.isArray(v) ? v : []; this.touch(); }
        }, 5000);
        await this.watch('rseCommand', 'de.bmw.infotainment.rsecommandcontrol.RSECommandControl', '3', {
            currentVolume: (v) => { this.state.screens.volume = Number(v); this.touch(); },
            rseMainSinkAudible: () => {}
        }, 2500);
        await this.watch('rseDisplay', 'de.bmw.infotainment.rsedisplaycontrol.RSEDisplayControl', '3', {
            displayBrightness: (v) => { this.state.screens.brightness = Number(v); this.touch(); },
            displayState: (v) => { this.state.screens.display = v; this.touch(); },
            normalModeReady: (v) => { this.state.screens.ready = v; this.touch(); }
        }, 2500);
        await this.watch('rseRemote', 'de.bmw.infotainment.rseremoteinput.RSERemoteInput', '3', {
            remoteControlEnabled: (v) => { this.state.screens.remote = !!v; this.touch(); }
        }, 3000);
        this.touch(); return this;
    }
    require(name) {
        if (!this.p[name] || !this.state.available[name]) throw new Error(name + ' control is not available right now');
        return this.p[name];
    }
    async operation(label, fn) {
        if (this.busy) throw new Error('Another rear control is in progress');
        this.busy = true; this.touch();
        try { await fn(); return label + ' accepted'; }
        finally { this.busy = false; this.touch(); }
    }
    async setClimateTemperature(side, value) {
        const v = Math.max(16, Math.min(28, Math.round(value)));
        const x = {
            controlTemperatureLeftHandAirConditioningRearCompartment: side === 'left' ? v : 255,
            controlTemperatureRightHandAirConditioningRearCompartment: side === 'right' ? v : 255,
            controlOperationPushButtonMaximumAirconRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlOperationPushButtonAirInjectionManifoldAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlBlowerSettingAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlOperationPushButtonModeAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT'
        };
        return this.operation('Rear ' + side + ' temperature', () => this.signals.set(this.require('climate'), 'climateFond', x));
    }
    async setClimateMode(auto) {
        const x = this.acFondCommand();
        x.operationModeAirConditioning2Tier = auto ? 'EIN' : 'AUS';
        return this.operation('Rear climate mode', async () => {
            await this.signals.set(this.require('climate'), 'acFond', x);
            this.state.climate.auto = !!auto;
            this.touch();
        });
    }
    async setBlower(level) {
        const n = Math.max(1, Math.min(9, Math.round(level)));
        const x = this.acFondCommand();
        x.operationModeAirConditioning2Tier = 'AUS';
        x.operationManualBlowerLevelClimate2SeatRow = 'STUFE_' + n;
        return this.operation('Rear blower', async () => {
            await this.signals.set(this.require('climate'), 'acFond', x);
            this.state.climate.auto = false;
            this.state.climate.blower = n;
            this.touch();
        });
    }
    acFondCommand() {
        return {
            operationAirconRearCompartment: 'SIGNAL_UNGUELTIG',
            operationAirConditioningDefault2Tier: 'KEINE_AUSWAHL', operationAirConditioningDefault3Tier: 'KEINE_AUSWAHL',
            operationOn2Tier: 'KEINE_AUSWAHL', operationOn3Tier: 'KEINE_AUSWAHL',
            operationModeAirConditioning2Tier: 'KEINE_AUSWAHL', operationModeAirConditioning3Tier: 'KEINE_AUSWAHL',
            operationLock2Tier: 'KEINE_AUSWAHL', operationLock3Tier: 'KEINE_AUSWAHL', operationAircon3Tier: 'KEINE_AUSWAHL',
            operationBlowerSettingAirConditionings2Tier: 'SIGNAL_UNBEFUELLT', operationBlowerSettingAirConditionings3Tier: 'SIGNAL_UNBEFUELLT',
            operationTemperatureTarget2TierDR: 255, operationTemperatureTarget2TierPS: 255, operationTemperatureTarget3Tier: 255,
            operationAirDistributionProgramClimate3Seat: 'SIGNAL_UNBEFUELLT', operationAirDistributionProgramClimate2Seat: 'SIGNAL_UNBEFUELLT',
            operationManualBlowerLevelClimate3SeatRow: 'SIGNAL_UNBEFUELLT', operationManualBlowerLevelClimate2SeatRow: 'SIGNAL_UNBEFUELLT'
        };
    }
    async climatePower(on) {
        const x = {
            operationAirconRearCompartment: on ? 'EINSCHALTEN__S__EIN' : 'AUSSCHALTEN__S_AUS',
            operationAirConditioningDefault2Tier: 'KEINE_AUSWAHL', operationAirConditioningDefault3Tier: 'KEINE_AUSWAHL',
            operationOn2Tier: on ? 'EIN' : 'AUS', operationOn3Tier: 'KEINE_AUSWAHL',
            operationModeAirConditioning2Tier: on ? 'EIN' : 'AUS', operationModeAirConditioning3Tier: 'KEINE_AUSWAHL',
            operationLock2Tier: 'KEINE_AUSWAHL', operationLock3Tier: 'KEINE_AUSWAHL', operationAircon3Tier: 'KEINE_AUSWAHL',
            operationBlowerSettingAirConditionings2Tier: 'SIGNAL_UNBEFUELLT', operationBlowerSettingAirConditionings3Tier: 'SIGNAL_UNBEFUELLT',
            operationTemperatureTarget2TierDR: 255, operationTemperatureTarget2TierPS: 255, operationTemperatureTarget3Tier: 255,
            operationAirDistributionProgramClimate3Seat: 'SIGNAL_UNBEFUELLT', operationAirDistributionProgramClimate2Seat: 'SIGNAL_UNBEFUELLT',
            operationManualBlowerLevelClimate3SeatRow: 'SIGNAL_UNBEFUELLT', operationManualBlowerLevelClimate2SeatRow: 'SIGNAL_UNBEFUELLT'
        };
        return this.operation('Rear climate ' + (on ? 'on' : 'off'),
            () => this.signals.set(this.require('climate'), 'acFond', x));
    }
    async setClimateSync(enabled) {
        const x = {
            operationScentSelectionSmell: 'SIGNAL_UNGUELTIG',
            controlScentIntensity: 'SIGNAL_UNBEFUELLT',
            operationAUCFront: 'SIGNAL_UNBEFUELLT',
            operationScent: 'SIGNAL_UNBEFUELLT',
            operationSync: enabled ? 'SYNCH_AN' : 'SYNCH_AUS'
        };
        return this.operation('Front-to-rear climate sync ' + (enabled ? 'on' : 'off'),
            () => this.signals.set(this.require('climate'), 'acSpecialFunction', x));
    }
    seatClimateValue(side, kind, level) {
        const x = {
            operationStratificationSeatHeaterDR: 8, operationStratificationSeatHeaterPS: 8,
            operationStratificationSeatHeaterDRR: 8, operationStratificationSeatHeaterPSR: 8,
            operationFunctionStageSeatHeaterDR: 'SIGNAL_UNBEFUELLT', operationFunctionStageSeatClimateDR: 'SIGNAL_UNBEFUELLT',
            operationFunctionStageSeatHeaterPS: 'SIGNAL_UNBEFUELLT', operationFunctionStageSeatClimatePS: 'SIGNAL_UNBEFUELLT',
            operationFunctionStageSeatHeaterDRR: 'SIGNAL_UNBEFUELLT', operationFunctionStageSeatClimateDRR: 'SIGNAL_UNBEFUELLT',
            operationFunctionStageSeatHeaterPSR: 'SIGNAL_UNBEFUELLT', operationFunctionStageSeatClimatePSR: 'SIGNAL_UNBEFUELLT',
            operationSeatHeater3Tier: 'SIGNAL_UNBEFUELLT'
        };
        const member = 'operationFunctionStageSeat' + (kind === 'heat' ? 'Heater' : 'Climate') + (side === 'left' ? 'DRR' : 'PSR');
        x[member] = 'STUFE_' + Math.max(0, Math.min(3, level)); return x;
    }
    setSeatClimate(side, kind, level) {
        return this.operation('Rear ' + side + ' ' + kind,
            () => this.signals.set(this.require('climate'), 'seatHeatingLamination', this.seatClimateValue(side, kind, level)));
    }
    massageValue(side, level, program) {
        const s = side === 'left' ? 'RLH' : 'RRH';
        const x = {};
        x['operationPneumaticSeat' + s + 'Intensity'] = level ? 'STUFE_' + level : 'RESERVIERT';
        x['operationPneumaticSeat' + s + 'Program'] = program ? 'PROGRAMM_' + program : (side === 'left' ? 'SIGNAL_UNBEFUELLT' : 'NOCHANGE');
        x['operationPopUp' + s] = 'SIGNAL_UNGUELTIG';
        x['operationSPNMVelocity' + s] = 'SIGNAL_UNBEFUELLT';
        x['operationMassage' + s] = 'SIGNAL_UNBEFUELLT'; return x;
    }
    setMassage(side, level, program) {
        const field = side === 'left' ? 'seatMassageRL' : 'seatMassageRR';
        return this.operation('Rear ' + side + ' massage',
            () => this.signals.set(this.require('comfort'), field, this.massageValue(side, level, program)));
    }
    async lumbar(side, action) {
        const field = side === 'left' ? 'adjustmentLumbarRL' : 'adjustmentLumbarRR';
        const member = side === 'left' ? 'operationAdjustmentLumbarRLH' : 'operationAdjustmentLumbarRRH';
        return this.operation('Rear ' + side + ' lumbar', async () => {
            const p = this.require('comfort'); await this.signals.set(p, field, { [member]: action });
            await pause(300); await this.signals.set(p, field, { [member]: 'KEINE_AKTION' });
        });
    }
    seatPosition(side) { return side === 'left' ? 'REAR_LEFT' : 'REAR_RIGHT'; }
    async moveSeatRaw(position, action, holdMs, token) {
        const p = this.require('seat');
        const r = await this.signals.call(p, 'startSeatOperation', { seatPosition: position, seatAction: action });
        const id = r && r.requestorID;
        if (id === undefined || id === null) throw new Error('Seat controller did not grant movement');
        this.activeSeatRequests.add(id);
        const until = Date.now() + Math.max(250, holdMs || 850);
        try {
            while (Date.now() < until) {
                if (token !== undefined && token !== this.seatCancelToken) throw new Error('Seat movement stopped');
                await pause(Math.min(400, Math.max(1, until - Date.now())));
                if (token !== undefined && token !== this.seatCancelToken) throw new Error('Seat movement stopped');
                await this.signals.call(p, 'aliveSeatOperation', { requestorID: id });
            }
        } finally {
            this.activeSeatRequests.delete(id);
            await this.signals.call(p, 'stopSeatOperation', { requestorID: id }).catch(() => {});
        }
    }
    async moveSeat(side, action, holdMs, position) {
        return this.operation((position === 'FRONT_RIGHT' ? 'Front passenger' : 'Rear ' + side) + ' seat', async () => {
            const token = this.seatCancelToken;
            this.state.seatMotion = { active: true, label: 'Manual adjustment', step: action }; this.touch();
            try { await this.moveSeatRaw(position || this.seatPosition(side), action, holdMs || 850, token); }
            finally { this.state.seatMotion = { active: false, label: 'Ready', step: '' }; this.touch(); }
        });
    }
    async stopSeatMovement() {
        this.seatCancelToken += 1;
        const p = this.p.seat;
        const ids = Array.from(this.activeSeatRequests);
        if (p) await Promise.all(ids.map((id) => this.signals.call(p, 'stopSeatOperation', { requestorID: id }).catch(() => {})));
        this.activeSeatRequests.clear();
        this.state.seatMotion = { active: false, label: 'Stopped', step: '' }; this.touch();
        return 'All seat movement stopped';
    }
    rearSeatNativeValue(side, command) {
        const right = side === 'right';
        const suffix = right ? 'PSSR' : 'DRSR';
        const value = {};
        [
            'operationFunctionAdjustmentLongitudinalPosition',
            'operationFunctionAdjustmentBackrestAngle',
            'operationFunctionAdjustmentTilt',
            'operationFunctionAdjustmentBackrestHead',
            'operationFunctionAdjustmentHeadrest'
        ].forEach((name) => { value[name + suffix] = 'KEINE_AKTION'; });
        if (right) value.operationFunctionSleepingPositionButtonPSSR = command === 'sleep' ? 'TASTE_BETAETIGT' : 'KEINE_AKTION';
        value['operationFunctionResetButton' + suffix] = command === 'reset' ? 'TASTE_BETAETIGT' : 'KEINE_AKTION';
        value['operationFunctionMemoryButton' + suffix] = 'KEINE_AKTION';
        value['storeEventMemory' + suffix] = 'SIGNAL_UNBEFUELLT';
        value['selectionSittingPositionMemory' + suffix] = 'SIGNAL_UNBEFUELLT';
        value['requesterSittingPositionMemory' + suffix] = 'HMI';
        return value;
    }
    async pulseRearSeatButton(side, command) {
        const p = this.require('comfort');
        const field = side === 'right' ? 'seatAdjustmentPSR' : 'seatAdjustmentDRR';
        await this.signals.set(p, field, this.rearSeatNativeValue(side, command));
        await pause(300);
        await this.signals.set(p, field, this.rearSeatNativeValue(side, 'none'));
    }
    async loungeMode(enabled) {
        const title = enabled ? 'Executive Lounge on' : 'Executive Lounge off';
        return this.operation(title, async () => {
            const token = ++this.seatCancelToken;
            this.state.seatMotion = {
                active: true,
                label: title,
                step: enabled ? 'Moving front passenger seat fully forward' : 'Retracting the Executive Lounge footrest'
            };
            this.touch();
            try {
                if (enabled) {
                    await this.moveSeatRaw('FRONT_RIGHT', 'SEAT_ADJUSTMENT_HORIZONTAL_FRONT', 20000, token);
                    this.state.seatMotion.step = 'Lowering the Executive Lounge footrest'; this.touch();
                    await this.moveSeatRaw('REAR_RIGHT', 'SEAT_ADJUSTMENT_FOOTREST_SWING_OUT', 14000, token);
                    this.state.seatMotion.step = 'Reclining the right rear seat'; this.touch();
                    await this.pulseRearSeatButton('right', 'sleep');
                } else {
                    await this.moveSeatRaw('REAR_RIGHT', 'SEAT_ADJUSTMENT_FOOTREST_RETRACT', 14000, token);
                    this.state.seatMotion.step = 'Returning the right rear seat'; this.touch();
                    await this.pulseRearSeatButton('right', 'reset');
                }
                this.state.seatModes.lounge = !!enabled;
            } finally {
                this.state.seatMotion = { active: false, label: 'Ready', step: '' };
                this.touch();
            }
        });
    }
    async resetRearSeats() {
        return this.operation('Reset both rear seats', async () => {
            await Promise.all([
                this.pulseRearSeatButton('left', 'reset'),
                this.pulseRearSeatButton('right', 'reset')
            ]);
            this.state.seatModes = { lounge: false, visibility: false };
            this.touch();
        });
    }
    async visibilityMode() {
        return this.operation('Rear visibility position', async () => {
            const token = ++this.seatCancelToken;
            this.state.seatMotion = { active: true, label: 'Rear visibility position', step: 'Tucking both rear seats' };
            this.touch();
            try {
                await Promise.all([
                    this.moveSeatRaw('REAR_LEFT', 'SEAT_ADJUSTMENT_HORIZONTAL_BACK', 15000, token),
                    this.moveSeatRaw('REAR_RIGHT', 'SEAT_ADJUSTMENT_HORIZONTAL_BACK', 15000, token)
                ]);
                await Promise.all([
                    this.moveSeatRaw('REAR_LEFT', 'SEAT_ADJUSTMENT_VERTICAL_DOWN', 15000, token),
                    this.moveSeatRaw('REAR_RIGHT', 'SEAT_ADJUSTMENT_VERTICAL_DOWN', 15000, token)
                ]);
                await Promise.all([
                    this.moveSeatRaw('REAR_LEFT', 'SEAT_ADJUSTMENT_BACKREST_ANGLE_BACK', 15000, token),
                    this.moveSeatRaw('REAR_RIGHT', 'SEAT_ADJUSTMENT_BACKREST_ANGLE_BACK', 15000, token)
                ]);
                await Promise.all([
                    this.moveSeatRaw('REAR_LEFT', 'SEAT_ADJUSTMENT_HEADREST_DOWN', 12000, token),
                    this.moveSeatRaw('REAR_RIGHT', 'SEAT_ADJUSTMENT_HEADREST_DOWN', 12000, token)
                ]);
                this.state.seatModes.visibility = true;
                this.state.seatModes.lounge = false;
                this.state.seatMotion = { active: false, label: 'Visibility position complete', step: '' };
                this.touch();
            } catch (e) {
                this.state.seatMotion = { active: false, label: e && e.message === 'Seat movement stopped' ? 'Stopped' : 'Visibility position interrupted', step: '' };
                this.touch();
                throw e;
            }
        });
    }
    seatTarget(side) { return side === 'left' ? 'FASH' : 'BFSH'; }
    seatMemoryValue(side, slot, mode) {
        const right = side === 'right';
        const suffix = right ? 'PSSR' : 'DRSR';
        const value = this.rearSeatNativeValue(side, 'none');
        value['operationFunctionMemoryButton' + suffix] = mode === 'recall' ? 'TASTE_' + slot + '_GEDRUECKT' : 'KEINE_AKTION';
        value['storeEventMemory' + suffix] = mode === 'store' ? 'M' + slot + '_SPEICHERN' : 'KEINE_AKTION';
        value['selectionSittingPositionMemory' + suffix] = this.seatTarget(side);
        value['requesterSittingPositionMemory' + suffix] = 'HMI';
        return value;
    }
    async storeSeatMemory(side, slot) {
        const n = Math.max(1, Math.min(3, Math.round(slot)));
        return this.operation('Rear ' + side + ' memory ' + n + ' stored', async () => {
            const p = this.require('comfort');
            const field = side === 'right' ? 'seatAdjustmentPSR' : 'seatAdjustmentDRR';
            await this.signals.set(p, field, this.seatMemoryValue(side, n, 'store'));
            await pause(300);
            await this.signals.set(p, field, this.seatMemoryValue(side, n, 'none'));
            this.state.memory = { side, status: 'Memory ' + n + ' stored', requestor: 'HMI' };
            this.touch();
        });
    }
    async recallSeatMemory(side, slot) {
        const n = Math.max(1, Math.min(3, Math.round(slot)));
        return this.operation('Rear ' + side + ' memory ' + n + ' requested', async () => {
            const p = this.require('comfort');
            const field = side === 'right' ? 'seatAdjustmentPSR' : 'seatAdjustmentDRR';
            await this.signals.set(p, field, this.seatMemoryValue(side, n, 'recall'));
            await pause(300);
            await this.signals.set(p, field, this.seatMemoryValue(side, n, 'none'));
            this.state.memory = { side, status: 'Memory ' + n + ' recalled', requestor: 'HMI' };
            this.touch();
        });
    }
    async shade(which, direction) {
        const x = { operationSwitchRLHSunBlind: 'KEINE_ANGABE', operationSwitchRearWindowBlindSunBlind: 'KEINE_ANGABE',
            operationSwitchRRHSunBlind: 'KEINE_ANGABE', operationSwitchAllShadowing: 'KEINE_ANGABE' };
        if (which === 'all') x.operationSwitchAllShadowing = direction === 'open' ? 'FAEHRT_AUF' : 'FAEHRT_ZU';
        else x[{ left: 'operationSwitchRLHSunBlind', right: 'operationSwitchRRHSunBlind', rear: 'operationSwitchRearWindowBlindSunBlind' }[which]] = 'TASTER_BETAETIGT';
        return this.operation((which === 'all' ? 'All shades' : which + ' shade'), async () => {
            const p = this.require('shades'); await this.signals.set(p, 'sunblind', x); await pause(170);
            x.operationSwitchRLHSunBlind = x.operationSwitchRearWindowBlindSunBlind = x.operationSwitchRRHSunBlind = x.operationSwitchAllShadowing = 'KEINE_ANGABE';
            await this.signals.set(p, 'sunblind', x);
        });
    }
    async screenFocus(side) {
        return this.operation('Rear screen selection', async () => {
            const life = this.require('lifecycle');
            await this.signals.call(life, 'requestRSE', {});
            await this.signals.set(life, 'rseLock', 'FULL_ACCESS');
            await this.signals.set(life, 'rseHmiMenu', true);
            await this.signals.set(this.require('rseLife'), 'focusIndicatorHMI', side === 'left' ? 'RSE_SELECTION_LEFT' : 'RSE_SELECTION_RIGHT');
        });
    }
    async screenPower(side, on) {
        return this.operation('Rear ' + side + ' screen', async () => {
            if (on) {
                await this.signals.call(this.require('lifecycle'), 'requestRSE', {});
                await this.signals.call(this.require('lifecycle'), 'requestRSEEntertainmentMode', {
                    rseEntertainmentMode: side === 'left' ? 'ENTERTAINMENT_MODE_LEFT' : 'ENTERTAINMENT_MODE_RIGHT'
                });
            } else await this.signals.call(this.require('rseLife'), side === 'left' ? 'leaveEntertainmentModeLeft' : 'leaveEntertainmentModeRight', {});
        });
    }
    async screenDisplay(on) { return this.operation('Rear display', () => this.signals.set(this.require('rseDisplay'), 'displayState', on ? 'ON' : 'OFF')); }
    async screenBrightness(value) { return this.operation('Rear display brightness', () => this.signals.set(this.require('rseDisplay'), 'displayBrightness', Math.max(0, Math.min(100, value)))); }
    async remote(kind, key) {
        return this.operation('Rear remote', async () => {
            const side = String(this.state.screens.focus).indexOf('RIGHT') >= 0 ? 'right' : 'left';
            const life = this.require('lifecycle');
            await this.signals.call(life, 'requestRSE', {});
            await this.signals.set(life, 'rseLock', 'FULL_ACCESS');
            await this.signals.set(life, 'rseHmiMenu', true);
            await this.signals.set(this.require('rseLife'), 'focusIndicatorHMI', side === 'left' ? 'RSE_SELECTION_LEFT' : 'RSE_SELECTION_RIGHT');
            for (let i=0; i<10 && !this.state.available.rseRemote; i++) await pause(200);
            return this.signals.call(this.require('rseRemote'), kind === 'direction' ? 'sendDirectionKey' : 'sendCommandKey', { keyValue: key });
        });
    }
}

module.exports = { RearControl, stage, blowerStage, active, rearTemperature };
