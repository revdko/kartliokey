// Bir okey masası: oturma, dağıtım, sıra, hamle doğrulama, puanlama ve botlar.
// Tüm kartları yalnızca sunucu bilir; her oyuncuya viewFor() ile sadece görmesi gerekenler gider.
'use strict';
const { MULT, SUIT_NAMES, SUITS, RL, cardVal, createEngine, makeDeck } = require('./rules');

// Online masada bot oyuncu yoktur. Bilgisayar yalnızca bağlantısı kopan ya da süresi dolan oyuncunun yerine oynar.
const TURN_LIMIT = +process.env.OKEY_TURN_LIMIT || 45000;   // hamle süresi (ms)
const AWAY_DELAY = +process.env.OKEY_AWAY_DELAY || 1500;    // kopan oyuncunun yerine oynamadan önce bekleme (ms)

class Table {
  constructor({ code, N, handLimit, onChange }) {
    this.code = code;
    this.N = N;
    this.handLimit = handLimit;
    this.onChange = onChange || (() => {});
    this.seats = new Array(N).fill(null);   // {token, name, connected, left}
    this.hostToken = null;
    this.phase = 'lobby';                    // lobby | play | result | over
    this.pts = new Array(N).fill(0);
    this.starter = 0;
    this.handNo = 0;
    this.R = null;
    this.msg = 'Oyuncular bekleniyor.';
    this.timer = null;
    this.lastActive = Date.now();
  }

  /* ---------- oturma ---------- */
  seatOf(token) { return token ? this.seats.findIndex(s => s && s.token === token) : -1; }
  humans() { return this.seats.filter(s => s && s.connected); }

  join(token, name) {
    name = String(name || '').trim().slice(0, 16) || 'Oyuncu';
    let i = this.seatOf(token);
    if (i >= 0) {                                   // yeniden bağlanma
      this.seats[i].connected = true;
      this.seats[i].left = false;
      this.seats[i].name = name;
      this.msg = `${name} masaya döndü.`;
      if (this.phase === 'play' && this.R.turn === i) this.scheduleTurn();
      this.changed();
      return { seat: i };
    }
    if (this.phase !== 'lobby') return { error: 'Bu masada oyun başladı. Yeni oyuncu katılamaz.' };
    i = this.seats.findIndex(s => !s);
    if (i < 0) return { error: 'Masa dolu.' };
    this.seats[i] = { token, name, connected: true, left: false };
    if (!this.hostToken) this.hostToken = token;
    const left = this.seats.filter(s => !s).length;
    this.msg = left ? `${name} masaya oturdu. ${left} kişi daha bekleniyor.` : `${name} masaya oturdu. Masa doldu, oyun başlatılabilir.`;
    this.changed();
    return { seat: i };
  }

  disconnect(token) {
    const i = this.seatOf(token);
    if (i < 0) return;
    const s = this.seats[i];
    if (this.phase === 'lobby') {
      this.seats[i] = null;
      if (this.hostToken === token) { const h = this.humans()[0]; this.hostToken = h ? h.token : null; }
      this.msg = `${s.name} masadan kalktı.`;
    } else {
      s.connected = false;
      this.msg = `${s.name} oyundan koptu. Dönene kadar yerine bilgisayar oynuyor.`;
      if (this.R && this.R.turn === i) this.scheduleTurn();
    }
    this.changed();
  }

  leave(token) {
    const i = this.seatOf(token);
    if (i < 0) return;
    if (this.phase === 'lobby') return this.disconnect(token);
    // oyun sürerken kalkan oyuncunun yerine bilgisayar oynar (geri dönebilir)
    const s = this.seats[i];
    s.connected = false; s.left = true;
    if (this.hostToken === token) { const h = this.humans()[0]; if (h) this.hostToken = h.token; }
    this.msg = `${s.name} masadan kalktı, yerine bilgisayar oynuyor.`;
    if (this.R && this.R.turn === i) this.scheduleTurn();
    this.changed();
  }

  /* ---------- oyun ---------- */
  start(token) {
    if (this.phase !== 'lobby') return { error: 'Oyun zaten başladı.' };
    if (token !== this.hostToken) return { error: 'Oyunu yalnızca masayı kuran başlatabilir.' };
    const empty = this.seats.filter(s => !s).length;
    if (empty) return { error: `Masa dolmadan oyun başlamaz. ${empty} kişi daha bekleniyor.` };
    this.pts = new Array(this.N).fill(0);
    this.handNo = 0;
    this.starter = 0;
    this.newRound();
    return {};
  }

  newRound() {
    this.handNo++;
    const deck = makeDeck();
    let ind; do { ind = deck.pop(); if (ind.s === 4) deck.unshift(ind); } while (ind.s === 4);
    const E = createEngine(ind);
    const N = this.N;
    const R = {
      E, deck, indicator: ind, okey: E.okey,
      hands: Array.from({ length: N }, () => []),
      discards: Array.from({ length: N }, () => []),
      turn: this.starter, step: 'draw', turnId: 1, deadline: 0, deadlineFor: 0,
      firstTurn: new Array(N).fill(true),
      shown: new Array(N).fill(0),
      ciftGo: new Array(N).fill(false),
      lastDrawn: new Array(N).fill(null),
      startPts: this.pts.slice(),
      result: null,
    };
    for (let t = 0; t < 7; t++) for (let k = 0; k < N; k++) R.hands[(this.starter + k) % N].push(deck.pop(), deck.pop());
    this.R = R;
    this.phase = 'play';
    this.msg = `${this.handNo}. el dağıtıldı. ${this.seats[R.turn].name} başlıyor.`;
    this.scheduleTurn();
    this.changed();
  }

  prevOf(i) { return (i + this.N - 1) % this.N; }

  action(token, a) {
    const seat = this.seatOf(token);
    if (seat < 0) return { error: 'Bu masada oturmuyorsun.' };
    if (this.phase !== 'play') return { error: 'Şu an hamle yapılamaz.' };
    const res = this.applyAction(seat, a || {});
    if (!res.error) this.lastActive = Date.now();
    return res;
  }

  applyAction(seat, a) {
    const R = this.R, E = R.E, name = this.seats[seat].name;
    switch (a.type) {
      case 'show': {
        if (!R.firstTurn[seat] || R.shown[seat]) return { error: 'Göstergeyi gösterme hakkın yok.' };
        if (!R.hands[seat].some(c => c.s !== 4 && E.isIndicator(c))) return { error: 'Elinde gösterge yok.' };
        R.shown[seat] = cardVal(R.indicator.r) * 10;
        this.pts[seat] -= R.shown[seat];
        this.msg = `${name} göstergeyi gösterdi (−${R.shown[seat]}).`;
        this.changed();
        return {};
      }
      case 'cift': {
        R.ciftGo[seat] = !!a.on;           // gizli: kimseye duyurulmaz
        this.changed(seat);
        return {};
      }
      case 'draw': {
        if (R.turn !== seat || R.step !== 'draw') return { error: 'Sıra sende değil.' };
        let c, how;
        if (a.from === 'pile') {
          const p = R.discards[this.prevOf(seat)];
          if (!p.length) return { error: 'Alınacak kart yok.' };
          c = p.pop(); how = `${this.seats[this.prevOf(seat)].name} oyuncusunun attığı ${E.cname(c)} kartını aldı`;
        } else {
          if (!R.deck.length) { this.endRound(-1); return {}; }
          c = R.deck.pop(); how = 'desteden çekti';
        }
        R.hands[seat].push(c);
        R.firstTurn[seat] = false;
        R.lastDrawn[seat] = c.id;
        R.step = 'discard';
        this.msg = `${name} ${how}.`;
        this.changed();
        return { card: c };
      }
      case 'discard': {
        if (R.turn !== seat || R.step !== 'discard') return { error: 'Önce kart çekmelisin.' };
        const hand = R.hands[seat];
        const k = hand.findIndex(c => c.id === a.cardId);
        if (k < 0) return { error: 'Bu kart elinde yok.' };
        const rest = hand.filter((_, j) => j !== k);
        if (a.finish && !E.canWin(rest)) return { error: 'Bu kartı atınca el bitmiyor.' };
        const d = hand[k];
        R.hands[seat] = rest;
        R.discards[seat].push(d);
        if (a.finish) { this.endRound(seat, d); return {}; }
        this.msg = `${name} ${E.cname(d)} attı.`;
        this.nextTurn();
        return {};
      }
    }
    return { error: 'Bilinmeyen hamle.' };
  }

  nextTurn() {
    const R = this.R;
    R.turn = (R.turn + 1) % this.N;
    R.step = 'draw';
    R.turnId++;
    if (!R.deck.length) { this.endRound(-1); return; }
    this.scheduleTurn();
    this.changed();
  }

  /* sıra zamanlayıcısı: bağlı oyuncuya 45 sn, kopan oyuncunun yerine kısa bekleyişten sonra bilgisayar */
  scheduleTurn() {
    clearTimeout(this.timer);
    if (this.phase !== 'play') return;
    const R = this.R, i = R.turn, s = this.seats[i], now = Date.now();
    if (R.deadlineFor !== R.turnId) { R.deadline = now + TURN_LIMIT; R.deadlineFor = R.turnId; }
    const delay = s.connected ? Math.max(0, R.deadline - now) : AWAY_DELAY;
    const id = R.turnId;
    this.timer = setTimeout(() => {
      if (this.R !== R || this.phase !== 'play' || R.turnId !== id) return;
      if (s.connected) this.msg = `${s.name} için süre doldu.`;
      this.botPlay(i, true);
    }, delay);
  }

  /* bilgisayar oyuncu (ya da süresi dolan oyuncu için otomatik hamle) */
  botPlay(i, standIn) {
    const R = this.R, E = R.E, hand = R.hands[i], name = this.seats[i].name;
    const parts = [];
    if (R.step === 'draw') {
      if (R.firstTurn[i] && !R.shown[i] && hand.some(c => c.s !== 4 && E.isIndicator(c))) {
        R.shown[i] = cardVal(R.indicator.r) * 10; this.pts[i] -= R.shown[i];
        parts.push(`göstergeyi gösterdi (−${R.shown[i]})`);
      }
      const cift = R.ciftGo[i];
      const pile = R.discards[this.prevOf(i)], top = pile[pile.length - 1];
      let takeIt = false;
      if (top) {
        if (E.isWild(top)) takeIt = true;
        else {
          const h15 = [...hand, top];
          if (h15.some((_, k) => E.canWin(h15.filter((__, j) => j !== k)))) takeIt = true;
          else if (cift) takeIt = hand.some(c => !E.isWild(c) && E.eff(c).s === E.eff(top).s && E.eff(c).r === E.eff(top).r);
          else {
            const base = E.score(hand).v; let bestWith = -1;
            for (let k = 0; k < 15; k++) { const v = E.score(h15.filter((_, j) => j !== k)).v; if (v > bestWith) bestWith = v; }
            takeIt = bestWith >= base + 6;
          }
        }
      }
      if (!takeIt && !R.deck.length) { this.endRound(-1); return; }
      const r = this.applyAction(i, { type: 'draw', from: takeIt ? 'pile' : 'deck' });
      if (r.error || this.phase !== 'play') return;
      parts.push(takeIt ? `${this.seats[this.prevOf(i)].name} oyuncusunun attığı ${E.cname(top)} kartını aldı` : 'desteden çekti');
    }
    // bitirebiliyorsa bitir (okeyle bitirmeyi tercih et)
    const h = R.hands[i];
    let winK = -1;
    for (let k = 0; k < h.length; k++) {
      if (E.canWin(h.filter((_, j) => j !== k))) { if (winK < 0 || E.isWild(h[k])) winK = k; if (E.isWild(h[k])) break; }
    }
    if (winK >= 0) { this.applyAction(i, { type: 'discard', cardId: h[winK].id, finish: true }); return; }
    const cift = R.ciftGo[i];
    let bi = -1, bv = -Infinity;
    for (let k = 0; k < h.length; k++) {
      if (E.isWild(h[k])) continue;
      const rest = h.filter((_, j) => j !== k);
      const v = (cift ? E.pairValue(rest) : E.score(rest).v) + (h[k].s === 4 ? -5 : 0) + Math.random() * 0.5;
      if (v > bv) { bv = v; bi = k; }
    }
    if (bi < 0) bi = 0;
    const d = h[bi];
    this.applyAction(i, { type: 'discard', cardId: d.id });
    parts.push(`${E.cname(d)} attı`);
    this.msg = `${name} (bilgisayar oynadı): ${parts.join(', ')}.`;
    this.changed();
  }

  endRound(winner, lastCard) {
    clearTimeout(this.timer);
    const R = this.R, E = R.E, N = this.N;
    const why = new Array(N).fill('');
    const mult = MULT[R.okey.s];
    let detail = '', groups = null;
    if (winner >= 0) {
      const type = E.winType(R.hands[winner]);
      const okeyFinish = E.isWild(lastCard);
      let factor = 1, biter = 1; const notes = [];
      if (type === 'cift') { factor *= 2; biter = mult; }
      if (okeyFinish) { factor *= 2; biter = type === 'cift' ? mult * 2 : mult; }
      if (type === 'cift') notes.push(okeyFinish ? 'çiftten okey atarak bitti' : 'çiftten bitti');
      else if (okeyFinish) notes.push('okey atarak bitti');
      if (biter > 1) notes.push(`${biter} biter`);
      this.pts[winner] += -100 * biter; why[winner] = 'bitti';
      for (let k = 0; k < N; k++) if (k !== winner) {
        const cs = E.wentCift(R.hands[k]); const cg = cs !== null || R.ciftGo[k];
        const sum = cs !== null ? cs : (cg ? E.ciftSumAny(R.hands[k]) : E.leftover(R.hands[k]));
        const f = factor * (cg ? 2 : 1);
        this.pts[k] += sum === 0 ? mult * f : sum * mult * f;
        const tail = `${factor > 1 ? ' × ' + factor : ''}${cg ? ' × 2 (çifte gitti)' : ''}`;
        why[k] = sum === 0 ? `hepsi ${cg ? 'çift' : 'per'} · ${mult}${tail}` : `${sum} × ${mult}${tail}`;
      }
      detail = `Çarpan ${mult} (${SUIT_NAMES[R.okey.s]})` + (notes.length ? ` · ${notes.join(', ')}` : '');
      groups = E.arrange(R.hands[winner]).groups.map(g => g.cards);
    }
    for (let k = 0; k < N; k++) if (R.shown[k]) why[k] = (why[k] ? why[k] + ' · ' : '') + `gösterge −${R.shown[k]}`;
    const gameOver = this.handLimit > 0 && this.handNo >= this.handLimit;
    R.result = {
      winner, lastCard: lastCard || null, detail, groups, why,
      delta: this.pts.map((p, k) => p - R.startPts[k]),
      okey: R.okey, gameOver,
    };
    this.phase = gameOver ? 'over' : 'result';
    this.starter = (this.starter + 1) % N;
    this.msg = winner < 0 ? 'Deste bitti, el berabere.' : `${this.seats[winner].name} eli bitirdi.`;
    this.changed();
  }

  nextRound(token) {
    if (this.seatOf(token) < 0) return { error: 'Bu masada oturmuyorsun.' };
    if (this.phase === 'result') { this.newRound(); return {}; }
    if (this.phase === 'over') {
      if (token !== this.hostToken) return { error: 'Yeni oyunu masayı kuran başlatır.' };
      this.pts = new Array(this.N).fill(0); this.handNo = 0; this.starter = 0;
      this.newRound(); return {};
    }
    return { error: 'El henüz bitmedi.' };
  }

  /* ---------- görünüm ---------- */
  viewFor(seat) {
    const R = this.R;
    const v = {
      code: this.code, N: this.N, handLimit: this.handLimit, handNo: this.handNo,
      phase: this.phase, you: seat, isHost: seat >= 0 && this.seats[seat] && this.seats[seat].token === this.hostToken,
      msg: this.msg, pts: this.pts.slice(),
      seats: this.seats.map((s, i) => s ? {
        name: s.name, connected: s.connected, away: !s.connected,
        host: s.token === this.hostToken,
        count: R && this.phase !== 'lobby' ? R.hands[i].length : 0,
      } : null),
    };
    if (R && this.phase !== 'lobby') {
      v.round = {
        indicator: R.indicator, okey: R.okey, mult: MULT[R.okey.s], deckCount: R.deck.length,
        turn: R.turn, step: R.step,
        discards: R.discards.map(p => p.slice(-2)),
        shown: R.shown.slice(),
        hand: seat >= 0 ? R.hands[seat] : [],
        firstTurn: seat >= 0 ? R.firstTurn[seat] : false,
        ciftGo: seat >= 0 ? R.ciftGo[seat] : false,
        lastDrawn: seat >= 0 ? R.lastDrawn[seat] : null,
        timeLeft: this.phase === 'play' && this.seats[R.turn].connected ? Math.max(0, R.deadline - Date.now()) : null,
        turnLimit: TURN_LIMIT,
      };
      if (R.result) {
        v.result = { ...R.result, hands: R.hands };   // el bitince tüm eller açılır
      }
    }
    return v;
  }

  changed(onlySeat) { this.lastActive = Date.now(); this.onChange(this, onlySeat); }
}

module.exports = { Table };
