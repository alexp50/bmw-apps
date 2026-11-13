import assert from "node:assert/strict";
import worker from "../src/worker.mjs";

class KV {
  constructor() { this.values = new Map(); }
  async put(k, v) { this.values.set(k, v); }
  async get(k, type) { const v = this.values.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
}
const env = {TELEMETRY: new KV(), CAR_WRITE_TOKEN: "write-secret", APP_READ_TOKEN: "read-secret", APP_COMMAND_TOKEN: "command-secret"};
const ctx = {waitUntil: (p) => p};
const payload = {schema:1, sampledAt:new Date().toISOString(), awake:true,
  telemetry:{insideTemperatureC:21.5,insideTemperatureSampledAt:new Date().toISOString(),insideTemperatureSource:"IHKA D8D7 undamped cabin sensor",outsideTemperatureC:7,batteryChargePercent:82,batteryVoltage:12.64,speedKmh:0,
    tyrePressureBar:{frontLeft:2.5,frontRight:2.5,rearLeft:2.7,rearRight:2.7}},
  climate:{on:true,frontDefrost:false,rearDefrost:false,fanDriver:3,driverHeat:0},
  assistant:{schema:1,sampledAt:new Date().toISOString(),
    warmup:{active:true,progressPercent:42,estimatedMinutesRemaining:8.5,estimatedKmRemaining:5.2,safeRpm:1900},
    trip:{current:{id:"trip-1",startedAt:new Date().toISOString(),distanceKm:4.2,durationSeconds:600,topSpeedKmh:72},recent:[]},
    health:{coolantC:58,oilTemperatureC:49,oilLevel:"OK",rangeKm:610,tankLitres:63},
    service:{items:[{name:"Engine oil",distance:"12000 km",date:"09/2027"}],summary:{name:"Engine oil"}},
    checkControl:{active:0,items:[]},connection:{bridgeVersion:"0.3.0",providersReady:9,providersTotal:9}}};

const call = (path, init = {}) => worker.fetch(new Request(`https://example.test${path}`, init), env, ctx);
let response = await call("/v1/cars/g12/telemetry", {
  method:"POST", headers:{authorization:"Bearer write-secret", "content-type":"application/json"}, body:JSON.stringify(payload)
});
assert.equal(response.status, 202);
response = await call("/v1/cars/g12/telemetry", {headers:{authorization:"Bearer read-secret"}});
assert.equal(response.status, 200);
const latest = await response.json();
assert.equal(latest.telemetry.insideTemperatureC, 21.5);
assert.equal(latest.telemetry.batteryVoltage, 12.64);
assert.equal(latest.climate.fanDriver, 3);
assert.equal(latest.assistant.warmup.progressPercent, 42);
assert.equal(latest.assistant.trip.current.distanceKm, 4.2);
assert.equal(latest.carId, "g12");
assert.equal((await call("/v1/cars/g12/telemetry")).status, 401);
const invalidBattery = structuredClone(payload);
invalidBattery.telemetry.batteryChargePercent = 255;
assert.equal((await call("/v1/cars/g12/telemetry", {
  method:"POST", headers:{authorization:"Bearer write-secret", "content-type":"application/json"}, body:JSON.stringify(invalidBattery)
})).status, 422);

response = await call("/v1/cars/g12/commands", {method:"POST", headers:{authorization:"Bearer command-secret", "content-type":"application/json"}, body:JSON.stringify({type:"seat_heat", seat:"driver", level:3})});
assert.equal(response.status, 202);
const queued = await response.json();
assert.equal(queued.status, "queued");
assert.equal(queued.level, 3);
assert.equal((await call("/v1/cars/g12/commands", {method:"POST", headers:{authorization:"Bearer command-secret", "content-type":"application/json"}, body:JSON.stringify({type:"seat_heat", seat:"roof", level:9})})).status, 422);
assert.equal((await call("/v1/cars/validate-auto/commands", {method:"POST", headers:{authorization:"Bearer command-secret", "content-type":"application/json"}, body:JSON.stringify({type:"set_auto", zone:"rearLeft", enabled:true})})).status, 202);
assert.equal((await call("/v1/cars/validate-sync/commands", {method:"POST", headers:{authorization:"Bearer command-secret", "content-type":"application/json"}, body:JSON.stringify({type:"set_sync", enabled:true})})).status, 202);
assert.equal((await call("/v1/cars/validate-recirc/commands", {method:"POST", headers:{authorization:"Bearer command-secret", "content-type":"application/json"}, body:JSON.stringify({type:"set_recirculation", mode:"auto"})})).status, 202);
assert.equal((await call("/v1/cars/validate-recirc/commands", {method:"POST", headers:{authorization:"Bearer command-secret", "content-type":"application/json"}, body:JSON.stringify({type:"set_recirculation", mode:"invalid"})})).status, 422);
assert.equal((await call("/v1/cars/g12/commands", {method:"POST", headers:{authorization:"Bearer command-secret", "content-type":"application/json"}, body:JSON.stringify({type:"rear_defrost_on"})})).status, 409);
response = await call("/v1/cars/g12/commands", {headers:{authorization:"Bearer write-secret"}});
assert.equal(response.status, 200);
const delivered = await response.json();
assert.equal(delivered.id, queued.id);
assert.equal(delivered.status, "delivered");
response = await call(`/v1/cars/g12/commands/${queued.id}`, {method:"POST", headers:{authorization:"Bearer write-secret", "content-type":"application/json"}, body:JSON.stringify({status:"accepted", result:"Seat heat level 3 accepted"})});
assert.equal(response.status, 200);
response = await call(`/v1/cars/g12/commands/${queued.id}`, {headers:{authorization:"Bearer command-secret"}});
assert.equal(response.status, 200);
assert.equal((await response.json()).status, "accepted");
assert.equal((await call("/v1/cars/g12/commands", {headers:{authorization:"Bearer write-secret"}})).status, 204);
assert.equal((await call("/v1/cars/g12/commands", {method:"POST", headers:{authorization:"Bearer read-secret", "content-type":"application/json"}, body:JSON.stringify({type:"climate_on"})})).status, 401);
console.log("Telemetry worker authentication, validation, command queue and acknowledgement checks passed.");
