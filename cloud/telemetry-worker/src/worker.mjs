const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}
});

async function sameSecret(supplied, expected) {
  if (!supplied || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(supplied)),
    crypto.subtle.digest("SHA-256", enc.encode(expected))
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let different = av.length ^ bv.length;
  for (let i = 0; i < Math.min(av.length, bv.length); i++) different |= av[i] ^ bv[i];
  return different === 0;
}

function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function validSnapshot(body) {
  if (!body || body.schema !== 1 || typeof body.telemetry !== "object" || Array.isArray(body.telemetry)) return false;
  const t = body.telemetry;
  const numberOrNull = (v) => v == null || (typeof v === "number" && Number.isFinite(v));
  if (!numberOrNull(t.insideTemperatureC) || !numberOrNull(t.outsideTemperatureC) ||
      !numberOrNull(t.batteryChargePercent) || !numberOrNull(t.batteryVoltage) || !numberOrNull(t.speedKmh)) return false;
  if (t.insideTemperatureC != null && (t.insideTemperatureC < -50 || t.insideTemperatureC > 100)) return false;
  if (t.batteryChargePercent != null && (t.batteryChargePercent < 0 || t.batteryChargePercent > 100)) return false;
  if (t.insideTemperatureSampledAt != null && Number.isNaN(Date.parse(t.insideTemperatureSampledAt))) return false;
  if (t.insideTemperatureSource != null && typeof t.insideTemperatureSource !== "string") return false;
  if (t.batteryVoltage != null && (t.batteryVoltage < 6 || t.batteryVoltage > 18)) return false;
  if (body.climate != null && (typeof body.climate !== "object" || Array.isArray(body.climate))) return false;
  if (body.assistant != null) {
    if (typeof body.assistant !== "object" || Array.isArray(body.assistant) || body.assistant.schema !== 1) return false;
    const a = body.assistant;
    if (a.warmup != null && (typeof a.warmup !== "object" || Array.isArray(a.warmup))) return false;
    if (a.trip != null && (typeof a.trip !== "object" || Array.isArray(a.trip) ||
        (a.trip.recent != null && (!Array.isArray(a.trip.recent) || a.trip.recent.length > 20)))) return false;
    if (a.health != null && (typeof a.health !== "object" || Array.isArray(a.health))) return false;
    if (a.service != null && (typeof a.service !== "object" || Array.isArray(a.service) ||
        (a.service.items != null && (!Array.isArray(a.service.items) || a.service.items.length > 20)))) return false;
    if (a.checkControl != null && (typeof a.checkControl !== "object" || Array.isArray(a.checkControl) ||
        (a.checkControl.items != null && (!Array.isArray(a.checkControl.items) || a.checkControl.items.length > 20)))) return false;
  }
  return true;
}

const seats = new Set(["driver", "frontPassenger", "rearLeft", "rearRight"]);
const recirculationModes = new Set(["fresh", "auto", "recirculate"]);
const simpleCommands = new Set([
  "climate_on", "climate_off", "defrost_on", "defrost_off",
  "rear_defrost_on", "rear_defrost_off"
]);
function normalizeCommand(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.type !== "string") return null;
  const type = body.type;
  if (simpleCommands.has(type)) return {type};
  if ((type === "seat_heat" || type === "seat_vent") && seats.has(body.seat) && Number.isInteger(body.level) && body.level >= 0 && body.level <= 3) {
    return {type, seat: body.seat, level: body.level};
  }
  if (type === "set_temperature" && typeof body.celsius === "number" && Number.isFinite(body.celsius) && body.celsius >= 16 && body.celsius <= 28) {
    return {type, celsius: Math.round(body.celsius * 2) / 2};
  }
  if (type === "set_fan" && Number.isInteger(body.level) && body.level >= 1 && body.level <= 9) return {type, level: body.level};
  if (type === "set_auto" && seats.has(body.zone) && typeof body.enabled === "boolean") return {type, zone: body.zone, enabled: body.enabled};
  if (type === "set_sync" && typeof body.enabled === "boolean") return {type, enabled: body.enabled};
  if (type === "set_recirculation" && recirculationModes.has(body.mode)) return {type, mode: body.mode};
  return null;
}

async function appendHistory(env, carId, snapshot) {
  const key = `history:${carId}`;
  const old = await env.TELEMETRY.get(key, "json") || [];
  const last = old.length ? Date.parse(old[old.length - 1].serverReceivedAt) : 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  old.push(snapshot);
  await env.TELEMETRY.put(key, JSON.stringify(old.slice(-288)));
}

async function commandList(env, carId) {
  return await env.TELEMETRY.get(`commands:${carId}`, "json") || [];
}
async function saveCommands(env, carId, commands) {
  await env.TELEMETRY.put(`commands:${carId}`, JSON.stringify(commands.slice(-30)));
}
function expireCommands(commands) {
  const now = Date.now();
  for (const command of commands) {
    if ((command.status === "queued" || command.status === "delivered") && Date.parse(command.expiresAt) <= now) {
      command.status = "expired";
      command.completedAt = new Date().toISOString();
      command.result = "The car did not collect this command before it expired.";
    }
  }
  return commands;
}

export default {
  async fetch(request, env, ctx) {
    const target = new URL(request.url);
    if (target.pathname === "/health") return json({ok: true, service: "parked-bmw-telemetry"});
    const match = /^\/v1\/cars\/([A-Za-z0-9_-]{1,48})\/(telemetry|history|commands)(?:\/([A-Za-z0-9-]{1,64}))?$/.exec(target.pathname);
    if (!match) return json({error: "not found"}, 404);
    const carId = match[1], resource = match[2], commandId = match[3], token = bearer(request);

    if (request.method === "POST" && resource === "telemetry" && !commandId) {
      if (!await sameSecret(token, env.CAR_WRITE_TOKEN)) return json({error: "unauthorized"}, 401);
      const length = Number(request.headers.get("content-length") || 0);
      if (length > 65536) return json({error: "payload too large"}, 413);
      let body;
      try { body = await request.json(); } catch (_) { return json({error: "invalid JSON"}, 400); }
      if (!validSnapshot(body)) return json({error: "invalid telemetry snapshot"}, 422);
      const snapshot = {...body, carId, serverReceivedAt: new Date().toISOString()};
      await env.TELEMETRY.put(`latest:${carId}`, JSON.stringify(snapshot));
      ctx.waitUntil(appendHistory(env, carId, snapshot));
      return json({ok: true, serverReceivedAt: snapshot.serverReceivedAt}, 202);
    }

    if (resource === "commands" && request.method === "POST" && !commandId) {
      if (!await sameSecret(token, env.APP_COMMAND_TOKEN)) return json({error: "unauthorized"}, 401);
      let body;
      try { body = await request.json(); } catch (_) { return json({error: "invalid JSON"}, 400); }
      const command = normalizeCommand(body);
      if (!command) return json({error: "unsupported or invalid command"}, 422);
      const now = new Date();
      const entry = {...command, id: crypto.randomUUID(), status: "queued", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 120000).toISOString()};
      const commands = expireCommands(await commandList(env, carId));
      if (commands.some((one) => one.status === "queued" || one.status === "delivered")) {
        return json({error: "another command is still pending"}, 409);
      }
      commands.push(entry);
      await saveCommands(env, carId, commands);
      return json(entry, 202);
    }

    if (resource === "commands" && request.method === "GET" && !commandId) {
      if (!await sameSecret(token, env.CAR_WRITE_TOKEN)) return json({error: "unauthorized"}, 401);
      const commands = expireCommands(await commandList(env, carId));
      const command = commands.find((one) => one.status === "queued");
      if (!command) { await saveCommands(env, carId, commands); return new Response(null, {status: 204, headers:{"cache-control":"no-store"}}); }
      command.status = "delivered";
      command.deliveredAt = new Date().toISOString();
      await saveCommands(env, carId, commands);
      return json(command);
    }

    if (resource === "commands" && request.method === "GET" && commandId) {
      if (!await sameSecret(token, env.APP_COMMAND_TOKEN)) return json({error: "unauthorized"}, 401);
      const commands = expireCommands(await commandList(env, carId));
      await saveCommands(env, carId, commands);
      const command = commands.find((one) => one.id === commandId);
      return command ? json(command) : json({error: "command not found"}, 404);
    }

    if (resource === "commands" && request.method === "POST" && commandId) {
      if (!await sameSecret(token, env.CAR_WRITE_TOKEN)) return json({error: "unauthorized"}, 401);
      let body;
      try { body = await request.json(); } catch (_) { return json({error: "invalid JSON"}, 400); }
      if (!body || !["accepted", "rejected", "error"].includes(body.status) || (body.result != null && typeof body.result !== "string")) {
        return json({error: "invalid command result"}, 422);
      }
      const commands = expireCommands(await commandList(env, carId));
      const command = commands.find((one) => one.id === commandId);
      if (!command) return json({error: "command not found"}, 404);
      command.status = body.status;
      command.result = String(body.result || "").slice(0, 512);
      command.completedAt = new Date().toISOString();
      await saveCommands(env, carId, commands);
      return json(command);
    }

    if (request.method === "GET" && (resource === "telemetry" || resource === "history") && !commandId) {
      if (!await sameSecret(token, env.APP_READ_TOKEN)) return json({error: "unauthorized"}, 401);
      const key = resource === "history" ? `history:${carId}` : `latest:${carId}`;
      const value = await env.TELEMETRY.get(key, "json");
      if (!value) return json({error: "no telemetry received"}, 404);
      return json(value);
    }
    return json({error: "method not allowed"}, 405);
  }
};
