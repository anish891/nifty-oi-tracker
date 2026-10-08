const fetch = require('node-fetch');

// Tiny key-value/list/hash store.
//  - Upstash Redis over REST when credentials are present (works on Vercel serverless:
//    no connection pool, no extra dependency). Accepts both the native Upstash names and the
//    names Vercel's Upstash/KV integration injects.
//  - In-memory fallback otherwise (fine for local dev; lost on every cold start in production).

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const TIMEOUT_MS = 3000;

const configured = Boolean(REST_URL && REST_TOKEN);
const backend = configured ? 'upstash' : 'memory';

// ── Upstash REST ─────────────────────────────────────────────────────────

async function rest(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${REST_URL.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Upstash HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function upstashCmd(args) {
  const json = await rest('', args);
  if (json.error) throw new Error(json.error);
  return json.result;
}

async function upstashPipeline(cmds) {
  const out = await rest('/pipeline', cmds);
  return out.map(r => {
    if (r.error) throw new Error(r.error);
    return r.result;
  });
}

// ── In-memory fallback ───────────────────────────────────────────────────

const mem = new Map(); // key -> { type, value, exp }

function memGet(key, type) {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(key); return null; }
  return type && e.type !== type ? null : e;
}

function memExpire(key, ttl) {
  const e = mem.get(key);
  if (e && ttl) e.exp = Date.now() + ttl * 1000;
}

async function memCmd(args) {
  const [cmd, key, ...rest] = args;
  switch (String(cmd).toUpperCase()) {
    case 'GET': return memGet(key, 'str')?.value ?? null;
    case 'SET': {
      const nx = rest.includes('NX');
      const exIdx = rest.indexOf('EX');
      if (nx && memGet(key)) return null;
      mem.set(key, { type: 'str', value: String(rest[0]), exp: exIdx >= 0 ? Date.now() + rest[exIdx + 1] * 1000 : 0 });
      return 'OK';
    }
    case 'RPUSH': {
      let e = memGet(key, 'list');
      if (!e) { e = { type: 'list', value: [], exp: 0 }; mem.set(key, e); }
      rest.forEach(v => e.value.push(String(v)));
      return e.value.length;
    }
    case 'LRANGE': {
      const e = memGet(key, 'list');
      if (!e) return [];
      const [start, stop] = rest.map(Number);
      return e.value.slice(start, stop === -1 ? undefined : stop + 1);
    }
    case 'EXPIRE': memExpire(key, Number(rest[0])); return 1;
    case 'HSET': {
      let e = memGet(key, 'hash');
      if (!e) { e = { type: 'hash', value: new Map(), exp: 0 }; mem.set(key, e); }
      e.value.set(String(rest[0]), String(rest[1]));
      return 1;
    }
    case 'HGETALL': {
      const e = memGet(key, 'hash');
      return e ? [...e.value.entries()].flat() : [];
    }
    default: throw new Error(`memory store: unsupported ${cmd}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────

const cmd = configured ? upstashCmd : memCmd;
const pipeline = configured ? upstashPipeline : cmds => Promise.all(cmds.map(memCmd));

module.exports = {
  backend,
  configured,

  /** Claim a key exactly once (true if this caller won). */
  async setNx(key, value, ttlSec) {
    return (await cmd(['SET', key, String(value), 'EX', ttlSec, 'NX'])) === 'OK';
  },
  async get(key) {
    return cmd(['GET', key]);
  },
  async set(key, value, ttlSec) {
    return cmd(ttlSec ? ['SET', key, String(value), 'EX', ttlSec] : ['SET', key, String(value)]);
  },
  async lrange(key, start = 0, stop = -1) {
    return cmd(['LRANGE', key, start, stop]);
  },
  async hset(key, field, value) {
    return cmd(['HSET', key, field, String(value)]);
  },
  async hgetall(key) {
    const flat = await cmd(['HGETALL', key]);
    const out = {};
    for (let i = 0; i < (flat || []).length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  },
  /** Run several commands in one round trip. */
  pipeline
};
