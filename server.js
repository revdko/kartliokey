// Kartlı Okey online sunucusu.
// Ek paket gerektirmez: sayfayı sunar ve masaları Node.js'in kendi http modülü üzerinde
// yazılmış küçük bir WebSocket katmanıyla yönetir.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
// Dosyalar klasörlü (game/, public/) ya da hepsi aynı yerde olabilir; ikisi de çalışır.
const HAS_DIRS = fs.existsSync(path.join(__dirname, 'game', 'table.js'));
const { Table } = require(HAS_DIRS ? './game/table' : './table');

const PORT = process.env.PORT || 3000;
const PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const FLAT = PUBLIC === __dirname;   // klasörsüz yerleşimde yalnızca index.html sunulur
// Sayfa başka bir adresten (ör. Netlify) açılıyorsa o adresleri virgülle yazın. Boşsa herkes bağlanabilir.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

/* ---------- statik dosyalar ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, tables: tables.size, players: clients.size }));
  }
  let file = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (file.endsWith('/') || file === '\\') file += 'index.html';
  if (FLAT && path.basename(file) !== 'index.html') { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Bulunamadı'); }
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

/* ---------- küçük WebSocket katmanı ---------- */
class Conn {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.alive = true; this.closed = false;
    this.onmessage = () => {}; this.onclose = () => {};
    socket.on('data', d => this.read(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
  }
  read(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 1 << 20) return this.close();          // 1 MB üstü mesaj yok
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let data = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = this.buf.subarray(off, off + 4); data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3];
      }
      this.buf = this.buf.subarray(need);
      this.alive = true;
      if (op === 0x1) this.onmessage(data.toString('utf8'));
      else if (op === 0x8) return this.close();
      else if (op === 0x9) this.frame(0xA, data);                   // ping -> pong
    }
  }
  frame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch (_) { this.end(); }
  }
  send(obj) { this.frame(0x1, Buffer.from(JSON.stringify(obj))); }
  ping() { this.frame(0x9, Buffer.alloc(0)); }
  close() { if (!this.closed) { this.frame(0x8, Buffer.alloc(0)); this.socket.end(); } this.end(); }
  end() { if (this.closed) return; this.closed = true; this.socket.destroy(); this.onclose(); }
}

server.on('upgrade', (req, socket) => {
  const origin = req.headers.origin || '';
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
      (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin) && origin !== `https://${req.headers.host}` && origin !== `http://${req.headers.host}`)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy();
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  onConnection(new Conn(socket));
});

/* ---------- masalar ---------- */
const tables = new Map();      // kod -> Table
const clients = new Set();     // Conn (her birinde .token ve .code)

const LETTERS = 'ABCDEFGHJKLMNPRSTUVYZ';   // karışabilecek harfler yok (I, O, Q, W, X)
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!tables.has(c)) return c;
  }
}

function broadcast(table, onlySeat) {
  for (const c of clients) {
    if (c.code !== table.code) continue;
    const seat = table.seatOf(c.token);
    if (onlySeat !== undefined && seat !== onlySeat) continue;
    c.send({ t: 'state', v: table.viewFor(seat) });
  }
}

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function handle(c, t, p) {
  p = p || {};
  if (t === 'hello') { c.token = clean(p.token, 64); return { ok: true }; }
  if (!c.token) return { error: 'Geçersiz oturum.' };

  if (t === 'create') {
    const N = [2, 3, 4].includes(+p.N) ? +p.N : 4;
    const handLimit = [0, 5, 7, 11].includes(+p.handLimit) ? +p.handLimit : 7;
    const code = newCode();
    const table = new Table({ code, N, handLimit, teams: !!p.teams && N === 4, onChange: broadcast });
    tables.set(code, table);
    leaveCurrent(c);
    c.code = code;
    const r = table.join(c.token, clean(p.name, 16));
    return { ...r, code };
  }
  if (t === 'join') {
    const code = clean(p.code, 8).toUpperCase();
    const table = tables.get(code);
    if (!table) return { error: 'Bu kodla bir masa bulunamadı. Kodu kontrol et.' };
    if (c.code !== code) leaveCurrent(c);
    c.code = code;
    const r = table.join(c.token, clean(p.name, 16));
    if (r.error) { c.code = null; return r; }
    c.send({ t: 'state', v: table.viewFor(r.seat) });
    return { ...r, code };
  }
  const table = c.code && tables.get(c.code);
  if (!table) return { error: 'Masaya bağlı değilsin.' };
  if (t === 'start') return table.start(c.token);
  if (t === 'action') return table.action(c.token, p);
  if (t === 'next') return table.nextRound(c.token);
  if (t === 'leave') { table.leave(c.token); c.code = null; return {}; }
  return { error: 'Bilinmeyen istek.' };
}

function leaveCurrent(c) {
  if (!c.code) return;
  const old = tables.get(c.code);
  const code = c.code; c.code = null;
  if (old && ![...clients].some(x => x !== c && x.code === code && x.token === c.token)) old.disconnect(c.token);
}

function onConnection(c) {
  clients.add(c);
  let count = 0, windowStart = Date.now();
  c.onmessage = text => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > 30) return;                       // saniyede 30 mesajdan fazlası yok sayılır
    let m; try { m = JSON.parse(text); } catch (_) { return; }
    let r;
    try { r = handle(c, m.t, m.p); } catch (e) { console.error(e); r = { error: 'Sunucu hatası.' }; }
    if (m.id != null) c.send({ t: 'reply', id: m.id, r });
  };
  c.onclose = () => { clients.delete(c); leaveCurrent(c); };
}

// bağlantıları canlı tut, cevap vermeyenleri kapat
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.close(); continue; }
    c.alive = false; c.ping();
  }
}, 25000);

// kimsenin bağlı olmadığı masaları 15 dakika sonra kaldır
setInterval(() => {
  const now = Date.now();
  for (const [code, t] of tables) {
    const anyone = [...clients].some(x => x.code === code);
    if (!anyone && now - t.lastActive > 15 * 60 * 1000) { clearTimeout(t.timer); tables.delete(code); }
  }
}, 60000);

server.listen(PORT, () => console.log(`Kartlı Okey sunucusu ${PORT} portunda çalışıyor`));
