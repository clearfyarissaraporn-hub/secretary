/*
 * เลขาส่วนตัว · เซิร์ฟเวอร์แจ้งเตือน + ซิงก์หลายเครื่อง (Cloudflare Worker, แผนฟรี) · v2
 * หน้าที่: เก็บเวลาเตือนที่แอปส่งมา แล้วทุก 1 นาทีตรวจว่าถึงเวลาหรือยัง ถ้าถึงจะสั่งมือถือให้เด้งแจ้งเตือน (Web Push)
 * ต้องผูก KV namespace ชื่อตัวแปร KV และตั้ง Cron Trigger "* * * * *"
 * ไม่ต้องตั้งรหัสอะไรเอง: เซิร์ฟเวอร์สร้างกุญแจ VAPID เองครั้งแรก และเครื่องแรกที่เชื่อมจะเป็นเจ้าของ
 */
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {'Content-Type': 'application/json; charset=utf-8', ...CORS}});
const enc = new TextEncoder();
const b64u = buf => { let s = ''; new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const KEEP_MS = 2 * 86400e3, LATE_MS = 6 * 3600e3;

async function vapid(env) {
  let v = await env.KV.get('vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
    v = {priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey))};
    await env.KV.put('vapid', JSON.stringify(v));
  }
  return v;
}
async function vapidHeader(env, endpoint) {
  const v = await vapid(env);
  const key = await crypto.subtle.importKey('jwk', {...v.priv, key_ops: ['sign']}, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
  const h = b64u(enc.encode(JSON.stringify({typ: 'JWT', alg: 'ES256'})));
  const p = b64u(enc.encode(JSON.stringify({aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:secretary-app@example.com'})));
  const sig = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, enc.encode(h + '.' + p));
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${v.pub}`;
}
async function sendPush(env, sub) {
  const r = await fetch(sub.endpoint, {method: 'POST', headers: {TTL: '86400', Urgency: 'high', Authorization: await vapidHeader(env, sub.endpoint), 'Content-Length': '0'}});
  return r.status;
}
async function auth(env, key, claim) {
  if (!key || String(key).length < 16) return false;
  const owner = await env.KV.get('owner');
  if (!owner) { if (!claim) return false; await env.KV.put('owner', key); return true; }
  return owner === key;
}
const devKey = d => 'dev:' + String(d).replace(/[^\w-]/g, '').slice(0, 64);

async function runDue(env) {
  const devs = (await env.KV.get('devices', 'json')) || [];
  const now = Date.now();
  for (const dev of devs) {
    const d = await env.KV.get(devKey(dev), 'json');
    if (!d || !d.sub) continue;
    const due = (d.items || []).filter(i => !i.pushed && i.at <= now && i.at > now - LATE_MS);
    if (!due.length) continue;
    const status = await sendPush(env, d.sub);
    if (status === 404 || status === 410) { d.sub = null; d.lastError = 'การสมัครรับแจ้งเตือนหมดอายุ ให้กดเชื่อมต่อใหม่ในแอป'; }
    else if (status >= 200 && status < 300) { due.forEach(i => { i.pushed = true; }); d.lastPush = now; d.lastError = ''; }
    else d.lastError = 'ส่งไม่สำเร็จ (รหัส ' + status + ')';
    d.items = d.items.filter(i => i.at > now - KEEP_MS);
    await env.KV.put(devKey(dev), JSON.stringify(d));
  }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});
    if (!env.KV) return json({ok: false, error: 'ยังไม่ได้ผูก KV (Settings › Bindings › KV namespace ชื่อตัวแปร KV)'}, 500);
    const url = new URL(req.url);
    try {
      if (url.pathname === '/' ) return json({ok: true, app: 'secretary-push', version: 2, sync: true, message: 'เซิร์ฟเวอร์แจ้งเตือนพร้อมใช้งาน · รองรับซิงก์'});
      if (url.pathname === '/vapid') return json({publicKey: (await vapid(env)).pub});
      if (url.pathname === '/sync' && req.method === 'POST') {
        const b = await req.json();
        if (!(await auth(env, b.key, true))) return json({ok: false, error: 'รหัสเจ้าของไม่ตรง'}, 403);
        if (!b.dev || !b.sub || !b.sub.endpoint) return json({ok: false, error: 'ข้อมูลไม่ครบ'}, 400);
        const old = (await env.KV.get(devKey(b.dev), 'json')) || {};
        const flags = {}; (old.items || []).forEach(i => { flags[i.id] = i; });
        const now = Date.now();
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 300)
          .filter(i => i && i.id && Number(i.at) > now - LATE_MS)
          .map(i => ({id: String(i.id).slice(0, 80), at: Number(i.at), title: String(i.title || '').slice(0, 120), body: String(i.body || '').slice(0, 200),
            pushed: !!(flags[i.id] && flags[i.id].pushed), shown: !!(flags[i.id] && flags[i.id].shown)}));
        await env.KV.put(devKey(b.dev), JSON.stringify({sub: b.sub, items, lastSync: now, lastPush: old.lastPush || 0, lastError: old.sub && old.sub.endpoint !== b.sub.endpoint ? '' : (old.lastError || '')}));
        const devs = (await env.KV.get('devices', 'json')) || [];
        if (!devs.includes(b.dev)) { devs.push(b.dev); await env.KV.put('devices', JSON.stringify(devs.slice(-10))); }
        return json({ok: true, items: items.length, next: items.filter(i => !i.pushed).sort((a, c) => a.at - c.at)[0] || null});
      }
      if (url.pathname === '/pending') {
        const key = url.searchParams.get('key'), dev = url.searchParams.get('dev');
        if (!(await auth(env, key, false))) return json({items: []}, 403);
        const d = await env.KV.get(devKey(dev), 'json');
        if (!d) return json({items: []});
        const now = Date.now();
        const items = (d.items || []).filter(i => !i.shown && i.at <= now + 60e3 && i.at > now - LATE_MS);
        if (items.length) { items.forEach(i => { i.shown = true; i.pushed = true; }); await env.KV.put(devKey(dev), JSON.stringify(d)); }
        return json({items: items.map(i => ({id: i.id, title: i.title, body: i.body}))});
      }
      if (url.pathname === '/test' && req.method === 'POST') {
        const b = await req.json();
        if (!(await auth(env, b.key, false))) return json({ok: false, error: 'รหัสเจ้าของไม่ตรง'}, 403);
        const d = await env.KV.get(devKey(b.dev), 'json');
        if (!d || !d.sub) return json({ok: false, error: 'เครื่องนี้ยังไม่ได้เชื่อม'}, 400);
        const now = Date.now();
        d.items = (d.items || []).filter(i => !String(i.id).startsWith('test-'));
        d.items.push({id: 'test-' + now, at: now, title: 'ทดสอบ: เลขาส่วนตัว 🔔', body: 'ถ้าเห็นข้อความนี้ แปลว่าแจ้งเตือนทำงานแล้ว แม้ปิดแอปก็เด้ง', pushed: true, shown: false});
        await env.KV.put(devKey(b.dev), JSON.stringify(d));
        const status = await sendPush(env, d.sub);
        return json({ok: status >= 200 && status < 300, status});
      }
      /* ---------- ซิงก์หลายเครื่อง (ข้อมูลเข้ารหัสจากในแอป เซิร์ฟเวอร์เปิดอ่านไม่ได้) ---------- */
      if (url.pathname === '/doc') {
        const key = url.searchParams.get('key'), p = url.searchParams.get('p') || '';
        if (!/^(vault|vault-prev|sync-test)$/.test(p)) return json({ok: false, error: 'ชื่อเอกสารไม่ถูกต้อง'}, 400);
        if (req.method === 'GET') {
          const owner = await env.KV.get('owner');
          if (!owner) return new Response('null', {headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS}});   /* ยังไม่มีเจ้าของ = ยังไม่มีข้อมูล */
          if (!(await auth(env, key, false))) return json({ok: false, error: 'รหัสเจ้าของไม่ตรง'}, 403);
          const r = await env.KV.getWithMetadata('doc:' + p);
          if (r.value == null) return new Response('null', {headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS}});
          return new Response(r.value, {headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Rev': String((r.metadata || {}).rev || 0), ...CORS}});
        }
        if (req.method === 'POST') {
          if (!(await auth(env, key, true))) return json({ok: false, error: 'รหัสเจ้าของไม่ตรง'}, 403);
          const text = await req.text();
          if (text.length > 20e6) return json({ok: false, error: 'ข้อมูลใหญ่เกินไป'}, 413);
          const rev = Number(url.searchParams.get('rev') || 0), base = url.searchParams.get('base');
          if (p === 'vault' && base != null) {
            /* เขียนได้เฉพาะเมื่อรุ่นบนเซิร์ฟเวอร์ตรงกับที่เครื่องนี้เห็นล่าสุด ไม่งั้นแจ้งชนกัน */
            const cur = await env.KV.getWithMetadata('doc:vault');
            const curRev = cur.value == null ? 0 : Number((cur.metadata || {}).rev || 0);
            if (curRev !== Number(base)) return new Response(JSON.stringify({ok: false, conflict: true, rev: curRev, doc: cur.value == null ? null : JSON.parse(cur.value)}), {status: 409, headers: {'Content-Type': 'application/json', ...CORS}});
            if (cur.value != null) await env.KV.put('doc:vault-prev', cur.value, {metadata: {rev: curRev}});
          }
          await env.KV.put('doc:' + p, text, {metadata: {rev}});
          return json({ok: true, rev});
        }
      }
      if (url.pathname === '/status') {
        const key = url.searchParams.get('key'), dev = url.searchParams.get('dev');
        if (!(await auth(env, key, false))) return json({ok: false, error: 'รหัสเจ้าของไม่ตรง'}, 403);
        const d = (await env.KV.get(devKey(dev), 'json')) || {};
        const now = Date.now();
        const up = (d.items || []).filter(i => !i.pushed && i.at > now).sort((a, c) => a.at - c.at);
        return json({ok: true, connected: !!d.sub, upcoming: up.length, next: up[0] || null, lastPush: d.lastPush || 0, lastSync: d.lastSync || 0, lastError: d.lastError || ''});
      }
      return json({ok: false, error: 'ไม่พบ'}, 404);
    } catch (e) {
      return json({ok: false, error: String(e && e.message || e)}, 500);
    }
  },
  async scheduled(event, env, ctx) { if (env.KV) ctx.waitUntil(runDue(env)); }
};
