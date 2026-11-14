'use strict';

const mgu=require('./kit/mgu');
const G=require('./kit/gauges');
const SETTINGS='de.bmw.dass.settingsdriverassistancefunctions.SettingsDriverAssistanceFunctions';
const FASUS='de.bmw.infotainment.fasus.FASuS';
const W=1600,H=520,GREEN='#32e875',RED='#ff3658',AMBER='#ffb52e',CYAN='#35d6d0',BLUE='#4aafff';
const FEATURES=[
  {title:'Acoustic warning',field:'settingFrontCollisionWarningSound',status:'statusForwardCollisionWarning',detail:'Front-collision sound; deactivation may last one ignition cycle.'},
  {title:'Driveaway prevention',field:'settingCrossTrafficBrakeWithBraking',fallback:'settingCrossTrafficBrake',status:'statusStartingPrevention',detail:'Warns and brakes for cross traffic when moving off.'},
  {title:'Close Passing Assistant',field:'settingNarrowPassageAssistant',status:'statusNarrowPassageAssistant',detail:'Lateral close-passing warning and brake support.'}
];
const n=(v)=>typeof v==='number'?v:v&&typeof v.value==='number'?v.value:v&&typeof v._value==='number'?v._value:null;
const valueLabel=(v)=>v===2?'ACTIVATED':v===1?'DEACTIVATED':v===0?'NOT CONFIGURABLE':'WAITING';
const availabilityLabel=(v)=>v===2?'OPERABLE':v===1?'NOT OPERABLE':v===0?'NOT AVAILABLE':'WAITING';
const statusLabel=(v)=>v===1?'ON':v===0?'OFF':v===2?'NOT ACTIVATABLE':v===3?'UNFILLED':'WAITING';
const colorFor=(s)=>s==='ON'||s==='ACTIVATED'||s==='OPERABLE'?GREEN:s==='NOT AVAILABLE'||s==='NOT ACTIVATABLE'?RED:s==='WAITING'||s==='UNFILLED'?AMBER:CYAN;

mgu.run({async start(ctx){
  const {ui}=ctx;let selected=0,page=0,notice='';let settingsConn=null,fasConn=null;
  const state={settings:{},fas:{},provider:false,fasProvider:false};
  const settingFields=['settingFrontCollisionWarningSound','settingCrossTrafficBrake','settingCrossTrafficBrakeWithBraking','settingNarrowPassageAssistant'];
  function receiveSetting(name,v){if(!v)return;state.settings[name]={value:n(v.value),availability:n(v.availability),raw:v,at:Date.now()};}
  function receiveFas(v){if(!v)return;for(const key of Object.keys(v))state.fas[key]=n(v[key]);}
  async function startSignals(){
    if(ctx.preview||!ctx.signals||!ctx.signals.hasNative||!ctx.signals.hasNative())return;
    const watches={};for(const f of settingFields)watches[f]=(v)=>receiveSetting(f,v);
    try{settingsConn=await ctx.signals.watch(SETTINGS,'1',watches,ctx.log,{pollMs:1000});state.provider=true;}catch(e){notice='BMW settings provider: '+e.message;}
    try{fasConn=await ctx.signals.watch(FASUS,'1',{statusIDriveFAS:(v)=>receiveFas(v),statusIDriveFASExtended:(v)=>receiveFas(v)},ctx.log,{pollMs:1000});state.fasProvider=true;}catch(e){notice=(notice?notice+' | ':'')+'FAS provider: '+e.message;}
  }
  function effective(f){
    const primary=state.settings[f.field],fallback=f.fallback&&state.settings[f.fallback];
    if(primary&&primary.availability!==0)return {setting:primary,name:f.field};
    if(fallback)return {setting:fallback,name:f.fallback};
    return {setting:primary||null,name:f.field};
  }
  function card(cv,t,x,y,w,h,f,index){
    const e=effective(f),s=e.setting||{},vl=valueLabel(s.value),al=availabilityLabel(s.availability),sl=statusLabel(state.fas[f.status]);
    G.panel(cv,t,x,y,w,h,f.title);
    if(index===selected)cv.strokeRoundRect(x+3,y+3,w-6,h-6,8,3,AMBER);
    cv.text(vl,x+24,y+91,32,colorFor(vl),{font:'bold'});
    cv.text(al,x+24,y+133,23,colorFor(al),{font:'bold'});
    cv.text('ECU '+sl,x+24,y+178,26,colorFor(sl),{font:'bold'});
    cv.text(f.detail,x+24,y+225,17,t.dim);
    cv.text(e.name,x+24,y+h-23,15,t.dim);
  }
  function rawPage(cv,t){
    G.panel(cv,t,24,112,1552,396,'BMW live decision chain');
    const rows=[];
    for(const f of FEATURES){const e=effective(f),s=e.setting||{};rows.push([f.title,valueLabel(s.value),availabilityLabel(s.availability),statusLabel(state.fas[f.status]),e.name]);}
    G.table(cv,t,48,163,1504,[{label:'Function',w:300},{label:'Requested',w:210},{label:'Availability',w:250},{label:'ECU state',w:240},{label:'BMW field',w:504}],rows,{rowH:61,size:19});
    cv.text('OPERABLE means BMW accepts the setting. NOT AVAILABLE or NOT ACTIVATABLE requires coding/provider investigation; this app does not bypass it.',48,486,17,t.dim);
  }
  async function render(){
    const t=ctx.theme(),cv=ctx.canvas(W,H).clear(t.bg);
    if(page===0){card(cv,t,24,112,496,396,FEATURES[0],0);card(cv,t,552,112,496,396,FEATURES[1],1);card(cv,t,1080,112,496,396,FEATURES[2],2);}
    else rawPage(cv,t);
    G.frame(cv,t,['Live probe','Raw decision chain'],page,[{text:state.provider?'SETTINGS LIVE':'SETTINGS WAITING',color:state.provider?GREEN:AMBER},{text:state.fasProvider?'FAS LIVE':'FAS WAITING',color:state.fasProvider?GREEN:AMBER}]);
    if(notice){cv.roundRect(260,420,1080,70,18,'#171f29ee');cv.text(notice,800,464,21,t.text,{align:'center'});}
    await ui.image('MAIN_GFX',cv);
  }
  async function enableSelected(){
    const f=FEATURES[selected],e=effective(f),s=e.setting;
    if(!settingsConn||!settingsConn.proxy){notice='BMW settings provider is not connected';return;}
    if(!s){notice=f.title+': waiting for live BMW state';return;}
    if(s.availability!==2){notice=f.title+': '+availabilityLabel(s.availability)+'; no write sent';return;}
    try{await ctx.signals.set(settingsConn.proxy,e.name,{value:2,availability:s.availability},5000);notice=f.title+': activation accepted; waiting for ECU readback';}
    catch(err){notice=f.title+': BMW rejected request: '+err.message;}
    setTimeout(()=>{notice='';},7000);
  }
  ui.onClick('BTN_SELECT',()=>{selected=(selected+1)%FEATURES.length;page=0;});
  ui.onClick('BTN_ENABLE',enableSelected);
  ui.onClick('BTN_PAGE',()=>{page=1-page;});
  ctx.onTab((i)=>{page=Math.max(0,Math.min(1,i));});
  if(ctx.app&&ctx.app.on)ctx.app.on('shutdown',()=>{for(const c of [settingsConn,fasConn])if(c&&c.shutdown)Promise.resolve(c.shutdown()).catch(()=>{});});
  await startSignals();ctx.loop('MAIN',60,render);
}});
