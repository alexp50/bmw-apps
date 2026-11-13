'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { setImage } = require('./kit/record');
const { RearControl } = require('./control');
const path = require('path');

const W = 1600, H = 520;
const PAGES = ['CAR', 'CLIMATE', 'SEATS', 'MASSAGE', 'SEAT CLIMATE', 'SHADES', 'RSE'];
const C = { orange:'#ff5728', orange2:'#ff9b32', cyan:'#42d7d0', blue:'#55aaff', green:'#38dc8b', red:'#ff4f58', dim:'#949aa4' };
const finite = (n) => typeof n === 'number' && isFinite(n);
const clean = (v) => String(v == null ? '' : v).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const short = (v, n) => { const s = clean(v); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const temp = (v) => finite(v) && v >= 16 && v <= 32 ? v.toFixed(0) + '°C' : '--';
const isOn = (v) => /USER_ON|FULL_ON|ENTERTAINMENT|WELCOME|ICONIC|ON/.test(String(v || ''));

const ASSETS = {
    car:'g12-vin.json', hero:'tc-hero-bg.json', seatLeft:'tc-seat-left.json', seatRight:'tc-seat-right.json',
    seatPassenger:'tc-seat-passenger.json', rse:'tc-rse.json', climate:'tc-climate-bg.json',
    climateLeft:'tc-climate-left.json', climateRight:'tc-climate-right.json', massage:'tc-massage.json',
    shades:'tc-shades.json', motionSeat:'tc-motion-seat.json', motionBack:'tc-motion-back.json',
    motionHead:'tc-motion-head.json', motionLumbar:'tc-motion-lumbar.json', motionFoot:'tc-motion-foot.json'
};
const images = {};
try {
    const pack = require('./kit/pack').open(path.join(__dirname, 'assets'));
    let id = 0x52434000;
    Object.keys(ASSETS).forEach((name) => {
        const a = pack.json(ASSETS[name]);
        if (!a || !a.w || !a.h || !a.rgba) return;
        const pixels = Buffer.from(a.rgba, 'base64');
        if (pixels.length !== a.w * a.h * 4) return;
        setImage(++id, a.w, a.h, pixels); images[name] = { id, w:a.w, h:a.h };
    });
} catch (_) { /* Vector fallbacks keep every control usable if an artwork file is unavailable. */ }

mgu.run({ async start(ctx) {
    let page = 0, selected = 0, side = 'right', notice = '', noticeGood = false;
    let hits = [], actions = [], holdHits = [], activeHold = null, positionPart = 'seat';
    const rear = new RearControl(ctx.signals, ctx.log, () => {});

    function run(label, fn) {
        notice = label + '...'; noticeGood = false;
        Promise.resolve().then(fn).then((message) => {
            notice = message || label + ' accepted'; noticeGood = true;
        }).catch((e) => {
            notice = short(e && e.message || e, 105); noticeGood = false; ctx.log.warn(notice);
        });
    }
    function action(label, fn, x, y, w, h) {
        const i = actions.length; actions.push({ label, fn });
        if (x !== undefined) hits.push({ x, y, w, h, fn:() => { selected = i; fn(); } });
        return i;
    }
    function button(cv, t, x, y, w, h, label, fn, color, on) {
        const i = action(label, fn, x, y, w, h), focus = i === selected;
        cv.roundRect(x, y, w, h, 7, on ? color : withAlpha(color, focus ? 0.25 : 0.09));
        cv.strokeRoundRect(x + 1, y + 1, w - 2, h - 2, 7, focus ? 3 : 1, focus ? '#ffffff' : withAlpha(color, 0.58));
        cv.text(label, x + w / 2, y + h / 2 + 7, 18, on ? '#11151a' : color, { align:'center', font:'bold' });
        return i;
    }
    function heldSeatButton(cv,t,x,y,w,h,label,seatSide,seatAction,position,color) {
        const tap = () => run(label, () => rear.moveSeat(seatSide, seatAction, 900, position));
        const i = button(cv,t,x,y,w,h,label,tap,color,false);
        const hit = { x,y,w,h };
        hit.down = () => {
            selected = i;
            activeHold = hit;
            notice = label + ' - hold to move'; noticeGood = false;
            Promise.resolve().then(() => rear.moveSeat(seatSide, seatAction, 30000, position)).then((message) => {
                if (activeHold === hit) {
                    notice = message || label + ' complete'; noticeGood = true;
                }
            }).catch((e) => {
                if (e && e.message === 'Seat movement stopped') return;
                notice = short(e && e.message || e, 105); noticeGood = false; ctx.log.warn(notice);
            });
        };
        hit.up = () => {
            activeHold = null;
            Promise.resolve(rear.stopSeatMovement()).then(() => {
                notice = label + ' stopped'; noticeGood = true;
            }).catch((e) => {
                notice = short(e && e.message || e, 105); noticeGood = false; ctx.log.warn(notice);
            });
        };
        holdHits.push(hit);
    }
    function panel(cv, t, x, y, w, h, label) {
        cv.roundRect(x, y, w, h, 5, withAlpha(t.text, 0.035));
        cv.text(label, x + 18, y + 31, 19, t.text, { font:'bold' });
    }
    function picture(cv, name, x, y, w, h, mode) {
        const a = images[name]; if (!a) return false;
        const scale = mode === 'cover' ? Math.max(w / a.w, h / a.h) : Math.min(w / a.w, h / a.h);
        const dw = a.w * scale, dh = a.h * scale;
        cv.image(a.id, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); return true;
    }
    function sectionTitle(cv, t, title, sub) {
        // The native tab bar already names the page. Keeping this area clear
        // avoids placing a second heading under the MGU's chrome mask.
    }
    function seatSelector(cv, t) {
        button(cv,t,1190,69,174,42,'REAR LEFT',()=>{side='left';selected=0;},C.orange,side==='left');
        button(cv,t,1374,69,196,42,'REAR RIGHT',()=>{side='right';selected=0;},C.orange,side==='right');
    }
    function donorBackdrop(cv, t, x, y, w, h) {
        if (!picture(cv,'hero',x,y,w,h,'cover')) cv.fillRect(x,y,w,h,'#14171d');
        for (let yy=y+15; yy<y+h; yy+=24) for (let xx=x+15; xx<x+w; xx+=24) cv.fillRect(xx,yy,2,2,withAlpha(t.text,0.16));
    }
    function hotspot(cv, x, y, key, fn) {
        const i=action(key,fn,x-15,y-15,30,30), focus=i===selected;
        cv.fillRect(x-7,y-7,14,14,focus?'#ffffff':C.orange);
        // The canvas exposes rounded outlines; strokeRect is unsupported and
        // used to abort rendering as soon as the Seats page was opened.
        cv.strokeRoundRect(x-10,y-10,20,20,2,2,focus?C.orange:C.orange2);
    }
    function setPage(i){
        if (typeof i === 'string') i = PAGES.indexOf(i.toUpperCase());
        i = Number(i);
        if (!Number.isFinite(i) || i < 0) return;
        page=Math.max(0,Math.min(PAGES.length-1,i));selected=0;notice='';
    }

    function overview(cv,t,s) {
        sectionTitle(cv,t,'CAR','BMW Touch Command rear-compartment functions');
        donorBackdrop(cv,t,22,132,720,348); picture(cv,'car',50,155,665,255);
        cv.text('740Ld xDrive  |  Executive Lounge',382,447,18,t.text,{align:'center',font:'bold'});
        const cards=[
            ['CLIMATE COMFORT',1,'climate',C.cyan],['SEATS',2,'seatRight',C.orange],
            ['SUN PROTECTION',5,'shades',C.orange2],['REAR ENTERTAINMENT',6,'rse',C.blue]
        ];
        cards.forEach((c,i)=>{
            const x=772+(i%2)*400,y=132+Math.floor(i/2)*174,w=378,h=158;
            const idx=action(c[0],()=>setPage(c[1]),x,y,w,h),focus=idx===selected;
            cv.roundRect(x,y,w,h,7,focus?withAlpha(c[3],0.20):withAlpha(t.text,0.045));
            cv.strokeRoundRect(x+1,y+1,w-2,h-2,7,focus?3:1,focus?'#ffffff':withAlpha(t.text,0.15));
            picture(cv,c[2],x+12,y+16,142,126);
            cv.text(c[0],x+164,y+65,21,c[3],{font:'bold'});
            cv.text(i===0?(s.climate.on?'ON':'OFF'):i===1?'HEAT / VENT / MASSAGE':i===2?'3 ELECTRIC BLINDS':'LEFT / RIGHT',x+164,y+101,15,t.dim);
        });
    }
    function climate(cv,t,s) {
        sectionTitle(cv,t,'Climate comfort','Rear controls stay independent; Sync applies the front settings to the rear');
        donorBackdrop(cv,t,22,132,760,348); picture(cv,'climate',38,145,728,324,'cover');
        picture(cv,'climateLeft',85,175,250,245); picture(cv,'climateRight',470,175,250,245);
        cv.text(temp(s.climate.left),210,235,46,C.cyan,{align:'center',font:'bold'});
        cv.text(temp(s.climate.right),595,235,46,C.cyan,{align:'center',font:'bold'});
        // Compact symmetric groups keep the right '+' inside this panel.
        [['left',68],['right',438]].forEach(([which,x])=>{
            const v=s.climate[which];
            button(cv,t,x,405,100,46,'-',()=>run('Temperature',()=>rear.setClimateTemperature(which,(finite(v)?v:22)-1)),C.cyan,false);
            button(cv,t,x+108,405,100,46,finite(v)?temp(v):'22°C',()=>run('Temperature',()=>rear.setClimateTemperature(which,22)),C.cyan,v===22);
            button(cv,t,x+216,405,100,46,'+',()=>run('Temperature',()=>rear.setClimateTemperature(which,(finite(v)?v:22)+1)),C.cyan,false);
        });
        panel(cv,t,812,132,758,348,'Rear climate control');
        button(cv,t,838,184,160,55,'CLIMATE ON',()=>run('Rear climate on',()=>rear.climatePower(true)),C.green,!!s.climate.on);
        button(cv,t,1012,184,160,55,'OFF',()=>run('Rear climate off',()=>rear.climatePower(false)),C.red,s.climate.on===false);
        button(cv,t,1186,184,160,55,'AUTO',()=>run('Rear automatic',()=>rear.setClimateMode(true)),C.orange,!!s.climate.auto);
        button(cv,t,1360,184,160,55,'SYNC',()=>run('Climate sync',()=>rear.setClimateSync(!s.climate.sync)),C.blue,!!s.climate.sync);
        const blowerBase = finite(s.climate.blower) && !s.climate.auto ? s.climate.blower : 5;
        cv.text('Rear blower',840,285,19,t.dim,{font:'bold'}); cv.text(s.climate.auto?'AUTO':(finite(s.climate.blower)?String(s.climate.blower):'--'),1035,295,40,C.cyan,{align:'center',font:'bold'});
        button(cv,t,838,320,190,52,'LOWER',()=>run('Rear blower',()=>rear.setBlower(Math.max(1,blowerBase-1))),C.cyan,false);
        button(cv,t,1044,320,190,52,'RAISE',()=>run('Rear blower',()=>rear.setBlower(Math.min(9,blowerBase+1))),C.cyan,false);
        cv.text('Sync is front to rear. Rear controls never command the front zones.',838,423,17,t.dim);
    }
    function seatSetting(cv,t,s) {
        const commonParts=[
            ['seat','FORE / AFT','FORWARD','BACKWARD','SEAT_ADJUSTMENT_HORIZONTAL_FRONT','SEAT_ADJUSTMENT_HORIZONTAL_BACK'],
            ['height','HEIGHT','RAISE','LOWER','SEAT_ADJUSTMENT_VERTICAL_UP','SEAT_ADJUSTMENT_VERTICAL_DOWN'],
            ['tilt','CUSHION TILT','TILT UP','TILT DOWN','SEAT_ADJUSTMENT_TILT_UP','SEAT_ADJUSTMENT_TILT_DOWN'],
            ['back','BACKREST','UPRIGHT','RECLINE','SEAT_ADJUSTMENT_BACKREST_ANGLE_FRONT','SEAT_ADJUSTMENT_BACKREST_ANGLE_BACK'],
            ['shoulder','UPPER BACKREST','FORWARD','BACKWARD','SEAT_ADJUSTMENT_BACKREST_HEAD_TO_FRONT','SEAT_ADJUSTMENT_BACKREST_HEAD_TO_BACK'],
            ['depth','THIGH SUPPORT','EXTEND','RETRACT','SEAT_ADJUSTMENT_DEPTH_ENLARGE','SEAT_ADJUSTMENT_DEPTH_REDUCE'],
            ['head','HEAD RESTRAINT','RAISE','LOWER','SEAT_ADJUSTMENT_HEADREST_UP','SEAT_ADJUSTMENT_HEADREST_DOWN'],
            ['lumbar','LUMBAR','UP / DOWN','FIRM / SOFT',null,null]
        ];
        const rightParts=commonParts.concat([
            ['foot','FOOTREST','EXTEND','RETRACT','SEAT_ADJUSTMENT_FOOTREST_SWING_OUT','SEAT_ADJUSTMENT_FOOTREST_RETRACT'],
            ['front','FRONT PASSENGER','FORWARD','BACKWARD','SEAT_ADJUSTMENT_HORIZONTAL_FRONT','SEAT_ADJUSTMENT_HORIZONTAL_BACK']
        ]);
        const parts=side==='right'?rightParts:commonParts;
        if(!parts.some((p)=>p[0]===positionPart)) positionPart='seat';
        const selectedPart=parts.find((p)=>p[0]===positionPart)||parts[0];
        const setSide=(next)=>()=>{side=next;positionPart='seat';selected=0;notice='';};

        panel(cv,t,22,132,390,348,'Choose rear seat');
        button(cv,t,42,176,168,50,'LEFT REAR',setSide('left'),C.orange,side==='left');
        button(cv,t,222,176,168,50,'RIGHT REAR',setSide('right'),C.orange,side==='right');
        cv.text('ONE-TOUCH POSITIONS',42,244,15,t.dim,{font:'bold'});
        button(cv,t,42,255,168,43,'VISIBILITY',()=>run('Visibility position',()=>rear.visibilityMode()),C.orange2,!!s.seatModes.visibility);
        button(cv,t,222,255,168,43,'RESET BOTH',()=>run('Reset rear seats',()=>rear.resetRearSeats()),C.orange,false);
        button(cv,t,42,306,168,43,'LOUNGE ON',()=>run('Lounge on',()=>rear.loungeMode(true)),C.orange,!!s.seatModes.lounge);
        button(cv,t,222,306,168,43,'LOUNGE OFF',()=>run('Lounge off',()=>rear.loungeMode(false)),C.orange2,s.seatModes.lounge===false);
        button(cv,t,42,357,348,38,'STOP ALL MOVEMENT',()=>run('Stop seats',()=>rear.stopSeatMovement()),C.red,!!s.seatMotion.active);
        cv.text('RECALL MEMORY',42,414,14,t.dim,{font:'bold'});
        [1,2,3].forEach((slot,i)=>button(cv,t,42+i*76,425,68,38,String(slot),()=>run('Recall memory '+slot,()=>rear.recallSeatMemory(side,slot)),C.orange,false));
        cv.text('SAVE',278,414,14,t.dim,{font:'bold'});
        [1,2,3].forEach((slot,i)=>button(cv,t,278+i*37,425,32,38,String(slot),()=>run('Store memory '+slot,()=>rear.storeSeatMemory(side,slot)),C.orange2,false));

        donorBackdrop(cv,t,430,132,550,348);
        // The movement artwork is a complete scene. Layering it over the selected
        // seat creates a double image, so render one side-specific scene only.
        picture(cv,side==='left'?'seatLeft':'seatRight',455,143,500,300);
        cv.roundRect(448,421,514,43,4,withAlpha('#000000',0.68));
        cv.text((side==='left'?'LEFT REAR  |  ':'RIGHT REAR  |  ')+selectedPart[1],705,448,19,C.orange,{align:'center',font:'bold'});
        if(s.seatMotion.active) cv.text(short(s.seatMotion.step||s.seatMotion.label,58),705,474,14,C.green,{align:'center'});

        panel(cv,t,998,132,572,348,'Complete seat adjustment');
        parts.forEach((p,i)=>{
            const col=i%2,row=Math.floor(i/2);
            button(cv,t,1016+col*272,174+row*47,258,40,p[1],()=>{positionPart=p[0];selected=0;},C.orange,positionPart===p[0]);
        });
        if(positionPart==='lumbar'){
            const y=414;
            heldSeatButton(cv,t,1016,y,126,48,'UP',side,'LUMBAR_UP',undefined,C.orange);
            heldSeatButton(cv,t,1150,y,126,48,'DOWN',side,'LUMBAR_DOWN',undefined,C.orange);
            heldSeatButton(cv,t,1288,y,126,48,'FIRMER',side,'LUMBAR_INFLATE',undefined,C.orange);
            heldSeatButton(cv,t,1422,y,126,48,'SOFTER',side,'LUMBAR_DEFLATE',undefined,C.orange);
        } else {
            const position=positionPart==='front'?'FRONT_RIGHT':undefined;
            heldSeatButton(cv,t,1016,414,258,48,selectedPart[2],side,selectedPart[4],position,C.orange);
            heldSeatButton(cv,t,1288,414,260,48,selectedPart[3],side,selectedPart[5],position,C.orange);
        }
    }
    function massage(cv,t,s) {
        sectionTitle(cv,t,'Seat massage','Original Touch Command massage programmes'); seatSelector(cv,t);
        const st=s[side];
        panel(cv,t,22,132,510,348,'Massage programme');
        const programs=['WHOLE BODY','BACK','SHOULDERS','LUMBAR'];
        programs.forEach((name,i)=>button(cv,t,48,180+i*64,286,49,name,()=>run(name,()=>rear.setMassage(side,Math.max(1,st.massage||1),i+1)),C.orange,st.program===i+1));
        [0,1,2,3].forEach((n,i)=>button(cv,t,350,180+i*64,156,49,n?'LEVEL '+n:'OFF',()=>run('Massage',()=>rear.setMassage(side,n,st.program||1)),C.orange,st.massage===n));
        donorBackdrop(cv,t,554,132,1016,348); picture(cv,'massage',830,136,520,340);
        cv.text((side==='left'?'LEFT':'RIGHT')+' REAR SEAT',1062,455,19,C.orange,{align:'center',font:'bold'});
    }
    function seatClimate(cv,t,s) {
        sectionTitle(cv,t,'Seat climate','Heating and ventilation for each rear comfort seat'); seatSelector(cv,t);
        const st=s[side]; donorBackdrop(cv,t,22,132,720,348);
        picture(cv,side==='left'?'seatLeft':'seatRight',150,136,470,338);
        panel(cv,t,772,132,798,348,(side==='left'?'Left':'Right')+' rear seat');
        cv.text('HEATING',810,207,19,C.red,{font:'bold'});
        [0,1,2,3].forEach((n,i)=>button(cv,t,955+i*145,174,128,53,n?String(n):'OFF',()=>run('Seat heating',()=>rear.setSeatClimate(side,'heat',n)),C.red,st.heat===n));
        cv.text('VENTILATION',810,300,19,C.blue,{font:'bold'});
        [0,1,2,3].forEach((n,i)=>button(cv,t,955+i*145,267,128,53,n?String(n):'OFF',()=>run('Seat ventilation',()=>rear.setSeatClimate(side,'vent',n)),C.blue,st.vent===n));
        cv.text('The active BMW seat controller confirms every change.',810,410,17,t.dim);
    }
    function shades(cv,t,s) {
        sectionTitle(cv,t,'Sun protection','Touch Command blind controls');
        donorBackdrop(cv,t,22,132,920,348); picture(cv,'shades',45,150,870,310);
        cv.text('INDIVIDUAL BLINDS',962,158,15,t.dim,{font:'bold'});
        const items=[['LEFT DOOR','left',962,174],['REAR BLIND','rear',1132,174],['RIGHT DOOR','right',1302,174]];
        items.forEach(v=>button(cv,t,v[2],v[3],160,62,v[0],()=>run(v[0],()=>rear.shade(v[1],'toggle')),C.orange,false));
        cv.text('ALL BLINDS',962,252,15,t.dim,{font:'bold'});
        button(cv,t,962,265,244,66,'OPEN ALL',()=>run('Open all blinds',()=>rear.shade('all','open')),C.green,false);
        button(cv,t,1230,265,244,66,'CLOSE ALL',()=>run('Close all blinds',()=>rear.shade('all','close')),C.orange,false);
        cv.text('Individual controls remain available while driving.',962,450,16,t.dim);
    }
    function screens(cv,t,s) {
        sectionTitle(cv,t,'Rear entertainment','Front control of the left and right RSE displays'); seatSelector(cv,t);
        const current=side==='left'?s.screens.left:s.screens.right,on=isOn(current);
        donorBackdrop(cv,t,22,132,500,348); picture(cv,'rse',118,150,310,280);
        cv.text(on?'DISPLAY ON':'DISPLAY OFF',270,442,21,on?C.green:C.orange,{align:'center',font:'bold'});
        panel(cv,t,548,132,1022,348,'Remote control');
        cv.text('DISPLAY',578,170,15,t.dim,{font:'bold'});
        button(cv,t,578,184,196,48,'POWER ON',()=>run('RSE power',()=>rear.screenPower(side,true)),C.green,on);
        button(cv,t,786,184,196,48,'POWER OFF',()=>run('RSE power',()=>rear.screenPower(side,false)),C.red,!on);
        button(cv,t,578,246,404,48,'SELECT '+(side==='left'?'LEFT':'RIGHT')+' DISPLAY',()=>run('RSE focus',()=>rear.screenFocus(side)),C.blue,false);
        const b=finite(s.screens.brightness)?s.screens.brightness:50;
        button(cv,t,578,308,196,48,'DIM',()=>run('Brightness',()=>rear.screenBrightness(b-10)),C.orange,false);
        button(cv,t,786,308,196,48,'BRIGHT',()=>run('Brightness',()=>rear.screenBrightness(b+10)),C.orange,false);

        cv.text('NAVIGATION',1040,170,15,t.dim,{font:'bold'});
        const remoteButton=(x,y,label,kind,key)=>button(cv,t,x,y,146,46,label,()=>run('Remote '+label,()=>rear.remote(kind,key)),C.blue,false);
        remoteButton(1200,184,'UP','direction','UP');
        remoteButton(1040,240,'LEFT','direction','LEFT');
        remoteButton(1200,240,'OK','direction','CENTER');
        remoteButton(1360,240,'RIGHT','direction','RIGHT');
        remoteButton(1200,296,'DOWN','direction','DOWN');
        remoteButton(1040,362,'HOME','command','HOME');
        remoteButton(1200,362,'BACK','command','BACK');
        remoteButton(1360,362,'PLAY','command','PLAY');
    }
    async function render(){
        const t=ctx.theme(),cv=ctx.canvas(W,H).clear('#0d1015'),s=rear.state;hits=[];actions=[];holdHits=[];
        [overview,climate,seatSetting,massage,seatClimate,shades,screens][page](cv,t,s);
        selected=actions.length?Math.max(0,Math.min(selected,actions.length-1)):0;
        G.frame(cv,t,PAGES,page,[{text:'TOUCH COMMAND',color:C.orange},{text:rear.busy?'WORKING':'LIVE',color:rear.busy?C.orange2:C.green},{text:'60 FPS',color:C.cyan}]);
        if(notice) cv.text(short(notice,105),1566,505,16,noticeGood?C.green:C.orange2,{align:'right',font:'bold'});
        await ctx.ui.image('MAIN_GFX',cv);
    }
    function next(delta){if(actions.length)selected=(selected+delta+actions.length)%actions.length;}
    ctx.ui.onClick('BTN_PAGE',()=>setPage((page+1)%PAGES.length));
    ctx.ui.onClick('BTN_SELECT',()=>next(1));
    ctx.ui.onClick('BTN_ACTION',()=>{if(actions[selected])actions[selected].fn();});
    ctx.ui.onClick('BTN_BACK',()=>setPage(0));
    ctx.onTab((i)=>setPage(i));
    ctx.onTouch((phase,x,y)=>{
        if(phase===1){
            const h=holdHits.find(v=>x>=v.x&&x<v.x+v.w&&y>=v.y&&y<v.y+v.h);
            if(!h) return false;
            activeHold=h; h.down(); return true;
        }
        if(!activeHold) return false;
        if(phase===3){
            const h=activeHold;
            h.up();
        }
        return true;
    });
    ctx.onTap((x,y)=>{const h=hits.find(v=>x>=v.x&&x<v.x+v.w&&y>=v.y&&y<v.y+v.h);if(h)h.fn();});
    ctx.loop('MAIN',60,render); await rear.init();
} });
