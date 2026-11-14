'use strict';
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const D = require('./catalog');
const { Controller } = require('./controller');
const { t: translate } = require('./kit/i18n');

const W = 1600, H = 520;
const C = { bg: '#0d1119', panel: '#1b2431', text: '#f3f6f9', dim: '#aebdca',
    blue: '#4cb5ff', red: '#ef6a67', green: '#56d89a', orange: '#ffb84c' };
const NAME = { BLUE: 'Blue', RED: 'Red', GREEN: 'Green', ORANGE: 'Orange' };
const COLOR = { BLUE: C.blue, RED: C.red, GREEN: C.green, ORANGE: C.orange };
const pages = ['Overview', 'Palette', 'Alerts', 'Signals'];
const short = (value, limit) => {
    const text = translate(value || '');
    return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
};

mgu.run({ async start(ctx) {
    let page = 0, selected = 0, closed = false, actions = [], hits = [];
    const controller = new Controller(ctx, redraw, translate);
    function redraw() { if (!closed && ctx.ui.isVisible('MAIN'))
        render().catch((e) => ctx.log.error('Ambient Studio screen', e)); }
    async function act(fn) {
        try { await fn(); } catch (e) { controller.notice = e.message; ctx.log.warn(e); }
        redraw();
    }
    function headline(cv, title, subtitle) {
        cv.text(title, 34, 83, 36, C.text, { font: 'bold' });
        cv.text(subtitle, 34, 113, 21, C.dim);
    }
    function panel(cv, x, y, w, h, color) {
        cv.roundRect(x, y, w, h, 10, C.panel);
        cv.fillRect(x, y, 5, h, color || C.blue);
    }
    function button(cv, x, y, w, h, label, fn, color) {
        const index = actions.length, chosen = selected === index;
        cv.roundRect(x, y, w, h, 9, chosen ? (color || C.blue) : C.panel);
        cv.text(short(label, 28), x + w / 2, y + h / 2 + 9, 25,
            chosen ? C.bg : C.text, { align: 'center', font: 'bold' });
        const call = () => act(fn);
        actions.push(call);
        hits.push({ x, y, w, h, fn: () => { selected = index; call(); } });
    }
    function overview(cv) {
        headline(cv, 'Ambient Studio', 'Drive-mode colours with learned factory slots');
        panel(cv, 32, 134, 972, 127, controller.modeEnabled ? C.green : C.orange);
        cv.text(controller.mode ? controller.mode.label : 'Drive mode: waiting', 54, 183, 32, C.text, { font: 'bold' });
        cv.text('Factory colour slot: ' + (controller.color || 'unknown'), 54, 226, 26, C.dim);
        panel(cv, 1020, 134, 548, 127, C.blue);
        cv.text('AUTOMATIC COLOURS', 1042, 177, 23, C.dim, { font: 'bold' });
        cv.text(controller.modeEnabled ? 'ON' : 'OFF', 1042, 235, 58,
            controller.modeEnabled ? C.green : C.orange, { font: 'bold' });
        D.SEMANTIC.forEach((key, i) => {
            const x = 32 + i * 388;
            panel(cv, x, 282, 372, 103, COLOR[key]);
            cv.text(NAME[key].toUpperCase(), x + 20, 323, 22, COLOR[key], { font: 'bold' });
            cv.text(controller.palette[key] ? 'Factory slot ' + controller.palette[key] : 'Not learned',
                x + 20, 360, 26, C.text, { font: 'bold' });
        });
        button(cv, 32, 408, 750, 66, controller.modeEnabled ? 'Disable drive-mode colours' :
            'Enable drive-mode colours', () => controller.setModeEnabled(!controller.modeEnabled), C.green);
        button(cv, 798, 408, 770, 66, 'Learn factory colours', () => { page = 1; selected = 0; redraw(); }, C.blue);
        cv.text(short(controller.status(), 110), 34, 507, 20,
            controller.notice ? C.red : C.dim);
    }
    function palette(cv) {
        headline(cv, 'Learn factory colours',
            "Choose a colour in BMW's ambient menu, return here, then press its Learn button.");
        panel(cv, 32, 134, 1536, 80, C.blue);
        cv.text('CURRENT FACTORY SLOT', 54, 172, 22, C.dim, { font: 'bold' });
        cv.text(controller.color === null ? 'Waiting' : String(controller.color), 610, 190, 52,
            controller.color === null ? C.orange : C.text, { font: 'bold' });
        D.SEMANTIC.forEach((key, i) => {
            const x = 32 + i * 388;
            panel(cv, x, 234, 372, 114, COLOR[key]);
            cv.text(NAME[key].toUpperCase(), x + 20, 273, 24, COLOR[key], { font: 'bold' });
            cv.text(controller.palette[key] ? 'Slot ' + controller.palette[key] : 'Not learned',
                x + 20, 318, 34, C.text, { font: 'bold' });
            button(cv, x, 366, 372, 62, controller.message('Learn {colour}', { colour: translate(NAME[key]) }),
                () => controller.learnColor(key), COLOR[key]);
        });
        button(cv, 1050, 448, 518, 54, 'Clear learned colours', () => controller.clearPalette(), C.red);
        cv.text(short(controller.notice || 'Each slot is specific to this car; no colour number is guessed.', 70),
            34, 484, 21, controller.notice ? C.orange : C.dim);
    }
    function alerts(cv) {
        headline(cv, 'Safety light alerts', 'Hazards pulse orange; engine-running door alert pulses red.');
        panel(cv, 32, 134, 754, 210, C.orange);
        cv.text('HAZARDS', 54, 177, 24, C.orange, { font: 'bold' });
        cv.text('Signal: ' + (controller.hazard === null ? 'not learned / unknown' :
            controller.hazard ? 'ON' : 'OFF'), 54, 220, 28, C.text);
        cv.text(controller.message('OFF {off}   ON {on}', {
            off: translate(controller.hazardLearn.off ? 'learned' : 'missing'),
            on: translate(controller.hazardLearn.on ? 'learned' : 'missing')
        }),
            54, 265, 23, C.dim);
        button(cv, 54, 280, 710, 52, controller.hazardEnabled ? 'Disable hazard alert' :
            'Enable hazard alert', () => controller.setHazardEnabled(!controller.hazardEnabled), C.orange);
        panel(cv, 802, 134, 766, 210, C.red);
        cv.text('DOOR OPEN + ENGINE RUNNING', 824, 177, 24, C.red, { font: 'bold' });
        cv.text(controller.doorProvider ? 'Door: ' + (controller.door ? 'OPEN' : 'closed / unknown') :
            'Door signal not configured', 824, 220, 26, C.text);
        cv.text('Engine: ' + (controller.engine === null ? 'unknown' :
            controller.engine ? 'running' : 'off'), 824, 265, 23, C.dim);
        button(cv, 824, 280, 722, 52, controller.doorEnabled ? 'Disable door alert' :
            'Enable door alert', () => controller.setDoorEnabled(!controller.doorEnabled), C.red);
        button(cv, 32, 354, 754, 70, 'Learn hazards OFF now', () => controller.learnHazard('off'), C.orange);
        button(cv, 802, 354, 766, 70, 'Learn hazards ON now', () => controller.learnHazard('on'), C.orange);
        cv.text(short(controller.notice || 'Door alert stays unavailable until the exact door signal is profiled.', 105),
            34, 476, 22, controller.notice ? C.red : C.dim);
        cv.text('Alerts switch between alert and normal colours about every 1.5 seconds.', 34, 506, 20, C.dim);
    }
    function signals(cv) {
        headline(cv, 'Vehicle signals', 'Live provider state and last colour request');
        const rows = [
            ['DRIVE MODE', controller.offered('mode') ? 'live' : 'waiting',
                controller.mode ? controller.mode.name : 'unknown', C.blue],
            ['AMBIENT', controller.offered('light') ? 'live' : 'waiting',
                'Factory slot ' + (controller.color || 'unknown'), C.green],
            ['ENGINE', controller.offered('engine') ? 'live' : 'waiting',
                controller.engine === null ? 'unknown' : controller.engine ? 'RUNNING' : 'off', C.orange],
            ['HAZARDS', controller.offered('hazard') ? 'live' : 'waiting',
                controller.hazard === null ? 'unknown' : controller.hazard ? 'ON' : 'OFF', C.orange]
        ];
        rows.forEach((r, i) => {
            const x = 32 + (i % 2) * 776, y = 134 + Math.floor(i / 2) * 125;
            panel(cv, x, y, 760, 109, r[3]);
            cv.text(r[0], x + 20, y + 39, 22, r[3], { font: 'bold' });
            cv.text(r[1].toUpperCase(), x + 733, y + 39, 20, C.dim, { align: 'right' });
            cv.text(short(r[2], 37), x + 20, y + 80, 26, C.text, { font: 'bold' });
        });
        cv.text('Door provider: ' + (controller.doorProvider ? 'live' : 'not configured'),
            34, 425, 23, controller.doorProvider ? C.green : C.orange);
        cv.text('Last colour request: ' + short(controller.lastWrite, 95), 34, 465, 23, C.dim);
        cv.text(short(controller.status(), 110), 34, 506, 20, C.dim);
    }
    async function render() {
        const cv = ctx.canvas(W, H).clear(C.bg);
        hits = []; actions = [];
        if (page === 0) overview(cv);
        else if (page === 1) palette(cv);
        else if (page === 2) alerts(cv);
        else signals(cv);
        G.frame(cv, ctx.theme(), pages, page,
            [{ text: controller.modeEnabled ? 'AUTO ON' : 'AUTO OFF',
                color: controller.modeEnabled ? C.green : C.orange }]);
        await ctx.ui.image('MAIN_GFX', cv);
    }
    ctx.ui.onClick('BTN_PAGE', () => { page = (page + 1) % pages.length; selected = 0; redraw(); });
    ctx.ui.onClick('BTN_SELECT', () => { selected = actions.length ? (selected + 1) % actions.length : 0; redraw(); });
    ctx.ui.onClick('BTN_ACTION', () => { if (actions[selected]) actions[selected](); });
    ctx.ui.onClick('BTN_BACK', () => { page = 0; selected = 0; redraw(); });
    ctx.onTab((i) => { page = i; selected = 0; redraw(); });
    ctx.onTap((x, y) => {
        const hit = hits.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
        if (hit) hit.fn();
    });
    ctx.onLayout(redraw);
    ctx.ui.onVisible((name, visible) => { if (name === 'MAIN' && visible) redraw(); });
    const close = () => { if (closed) return; closed = true; controller.close(); };
    if (ctx.app && ctx.app.on) ctx.app.on('shutdown', close);
    process.once('exit', close);
    redraw();
    await controller.start();
} });
