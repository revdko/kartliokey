// Kartlı Okey kural motoru (sunucu). İstemcideki motorla aynı kuralları uygular.
'use strict';
const SUITS=['♠','♥','♦','♣'];
const SUIT_NAMES=['Maça','Kupa','Karo','Sinek'];
const MULT=[3,5,4,6]; // maça, kupa, karo, sinek
const cardVal=r=>(r===1||r>=11)?10:r;
const RL=r=>({1:'A',11:'J',12:'Q',13:'K'}[r]||String(r));

function createEngine(indicator){
  const S={indicator, okey:{s:indicator.s, r:indicator.r%13+1}, ciftGo:[]};
  let memoWin=new Map(), memoBest=new Map();
  /* ---------- kart yardımcıları ---------- */
  function makeDeck(){
    const d=[]; let id=0;
    for(let k=0;k<2;k++) for(let s=0;s<4;s++) for(let r=1;r<=13;r++) d.push({id:id++,s,r});
    d.push({id:id++,s:4,r:0}); d.push({id:id++,s:4,r:0});
    for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]];}
    return d;
  }
  const isWild=c=>c.s!==4 && c.s===S.okey.s && c.r===S.okey.r;
  const eff=c=>c.s===4?{s:S.okey.s,r:S.okey.r}:c;
  const cname=c=>c.s===4?'Joker':SUITS[c.s]+RL(c.r);
  const isIndicator=c=>c.s===S.indicator.s && c.r===S.indicator.r;

  function toCnt(cards){
    const cnt=new Array(56).fill(0); let w=0;
    for(const c of cards){ if(isWild(c)){w++;continue;} const e=eff(c); cnt[e.s*14+e.r]++; }
    return {cnt,w};
  }
  function firstCard(cnt){
    for(let r=1;r<=13;r++) for(let s=0;s<4;s++) if(cnt[s*14+r]>0) return [s,r];
    return null;
  }
  /* bir kartı içeren tüm perleri üret: cb(kaldırılacak [[s,r]...], kullanılan okey sayısı, tür) */
  function genMelds(cnt,s,r,w,cb){
    const others=[]; for(let t=0;t<4;t++) if(t!==s && cnt[t*14+r]>0) others.push(t);
    for(let m=0;m<(1<<others.length);m++){
      const pick=[[s,r]]; for(let b=0;b<others.length;b++) if(m&(1<<b)) pick.push([others[b],r]);
      const k=pick.length;
      for(let u=Math.max(0,3-k);u<=Math.min(w,4-k);u++) if(k+u>=3) cb(pick,u,'g');
    }
    const used=(list,rk)=>list.reduce((a,x)=>a+(x[1]===rk?1:0),0);
    const walk=(k,list,len,wu)=>{
      if(len>=3) cb(list,wu,'r');
      if(len>=13||k>14) return;
      if(k===14 && r===1) return;
      const rk=k===14?1:k;
      if(cnt[s*14+rk]-used(list,rk)>0) walk(k+1,[...list,[s,rk]],len+1,wu);
      if(wu<w) walk(k+1,list,len+1,wu+1);
    };
    const maxP=r===1?0:Math.min(w,r-1);
    for(let p=0;p<=maxP;p++) walk(r+1,[[s,r]],1+p,p);
    if(r===1){
      const down=(k,list,len,wu)=>{
        if(k<2) return;
        const opts=[];
        if(cnt[s*14+k]>0) opts.push([[...list,[s,k]],wu]);
        if(wu<w) opts.push([list,wu+1]);
        for(const [l,u] of opts){ if(len+1>=3) cb(l,u,'r'); down(k-1,l,len+1,u); }
      };
      down(13,[[s,1]],1,0);
    }
  }
  function minus(cnt,list){const n=cnt.slice(); for(const [s,r] of list) n[s*14+r]--; return n;}

  function canWinCnt(cnt,w){
    const key=cnt.join('')+'|'+w;
    if(memoWin.has(key)) return memoWin.get(key);
    const f=firstCard(cnt); let ok=false;
    if(!f) ok=true;
    else{
      const [s,r]=f;
      try{ genMelds(cnt,s,r,w,(list,u)=>{ if(canWinCnt(minus(cnt,list),w-u)){ok=true; throw 0;} }); }catch(e){ if(e!==0) throw e; }
    }
    memoWin.set(key,ok); return ok;
  }
  function pairsOK(cnt,w){ let singles=0; for(const v of cnt) singles+=v%2; return singles<=w; }
  /* çiftten bitme: hepsi çift ya da bir per + kalanı çift. Uygunsa per'i döndürür ({list:[],u:0} = sadece çift) */
  function ciftMeld(cnt,w){
    if(pairsOK(cnt,w)) return {list:[],u:0,type:'p'};
    for(let r=1;r<=13;r++) for(let s=0;s<4;s++) if(cnt[s*14+r]>0){
      let found=null;
      try{ genMelds(cnt,s,r,w,(list,u,type)=>{
        if((list.length+u)%2===0 && pairsOK(minus(cnt,list),w-u)){ found={list,u,type}; throw 0; }
      }); }catch(e){ if(e!==0) throw e; }
      if(found) return found;
    }
    return null;
  }
  /* false | 'per' | 'cift' */
  function winType(cards){
    if(cards.length!==14) return false;
    const {cnt,w}=toCnt(cards);
    if(canWinCnt(cnt,w)) return 'per';
    return ciftMeld(cnt,w)?'cift':false;
  }
  const canWin=cards=>!!winType(cards);

  function best(cnt,w){
    const key=cnt.join('')+'|'+w;
    if(memoBest.has(key)) return memoBest.get(key);
    const f=firstCard(cnt);
    let res;
    if(!f) res={v:w*8,melds:[]};
    else{
      const [s,r]=f;
      const rest=minus(cnt,[[s,r]]);
      let bonus=0;
      for(let t=0;t<4;t++) if(t!==s && rest[t*14+r]>0) bonus=Math.max(bonus,3);
      for(const d of [1,2]){ const rk=r+d>13?r+d-13:r+d; if(rest[s*14+rk]>0) bonus=Math.max(bonus,d===1?4:2); }
      if(rest[s*14+r]>0) bonus=Math.max(bonus,1);
      const sk=best(rest,w);
      res={v:sk.v+bonus,melds:sk.melds};
      genMelds(cnt,s,r,w,(list,u,type)=>{
        const sub=best(minus(cnt,list),w-u);
        const v=(list.length+u)*10+sub.v;
        if(v>res.v) res={v,melds:[{list,u,type},...sub.melds]};
      });
    }
    memoBest.set(key,res); return res;
  }
  const score=cards=>{const {cnt,w}=toCnt(cards); return best(cnt,w);};
  /* per olmamış kartların en düşük toplamı */
  let memoPen=new Map();
  function minPen(cnt,w){
    const key=cnt.join('')+'|'+w;
    if(memoPen.has(key)) return memoPen.get(key);
    const f=firstCard(cnt); let v=0;
    if(f){
      const [s,r]=f;
      v=cardVal(r)+minPen(minus(cnt,[[s,r]]),w);
      genMelds(cnt,s,r,w,(list,u)=>{ const x=minPen(minus(cnt,list),w-u); if(x<v) v=x; });
    }
    memoPen.set(key,v); return v;
  }
  const leftover=cards=>{const {cnt,w}=toCnt(cards); return minPen(cnt,w);};

  function cmpRun(a,b){
    const wa=isWild(a), wb=isWild(b); if(wa!==wb) return wa?1:-1;
    const A=eff(a),B=eff(b); return A.s-B.s||A.r-B.r;
  }
  function cmpGroup(a,b){
    const wa=isWild(a), wb=isWild(b); if(wa!==wb) return wa?1:-1;
    const A=eff(a),B=eff(b); return A.r-B.r||A.s-B.s;
  }
  function pullMeld(pool,m){
    const g=[]; const take=pred=>{const i=pool.findIndex(pred); return i<0?null:pool.splice(i,1)[0];};
    for(const [s,r] of m.list){ const c=take(c=>!isWild(c)&&eff(c).s===s&&eff(c).r===r); if(c) g.push(c); }
    for(let i=0;i<m.u;i++){ const c=take(isWild); if(c) g.push(c); }
    if(m.type==='r'){
      const hi=g.some(c=>!isWild(c)&&eff(c).r>=12);
      const key=c=>isWild(c)?99:(eff(c).r===1&&hi?14:eff(c).r);
      g.sort((a,b)=>key(a)-key(b));
    }
    return g;
  }
  function arrangePairs(cards){
    const {cnt,w}=toCnt(cards); const m=ciftMeld(cnt,w);
    const pool=cards.slice(); const pre=[];
    if(m && m.list.length){ pre.push({cards:pullMeld(pool,m),kind:'meld'}); }
    const nonw=pool.filter(c=>!isWild(c)).sort(cmpRun), wl=pool.filter(isWild), out=[];
    while(nonw.length){ const a=nonw.shift(); const j=nonw.findIndex(b=>eff(b).s===eff(a).s&&eff(b).r===eff(a).r); out.push(j>=0?[a,nonw.splice(j,1)[0]]:[a,wl.shift()]); }
    while(wl.length) out.push(wl.splice(0,2));
    return {groups:[...pre,...out.map(g=>({cards:g,kind:'pair'}))],rest:[]};
  }
  function arrange(cards){
    if(winType(cards)==='cift') return arrangePairs(cards);
    const {melds}=score(cards);
    const pool=cards.slice(); const groups=[];
    for(const m of melds) groups.push({cards:pullMeld(pool,m),kind:'meld'});
    return {groups,rest:pool.sort(cmpRun)};
  }
  /* elde: perlere mi çiftlere mi gidiliyor, ona göre diz */
  function smartArrange(cards){
    if(cards.length===14 && winType(cards)) return arrange(cards);
    if(S.ciftGo && S.ciftGo[0]) return ciftArrange(cards);
    // seri: önce perler, kalanlardan çiftler
    const per=arrange(cards); const pr=pairArrange(per.rest);
    return {groups:[...per.groups,...pr.groups],rest:pr.rest};
  }
  /* çift: en fazla kartı kapsayan (bir per +) çiftler */
  function ciftArrange(cards){
    const {cnt,w}=toCnt(cards);
    let bestM=null, bestV=pairsFromCnt(cnt,w).pairs*2;
    for(let r=1;r<=13;r++) for(let s=0;s<4;s++) if(cnt[s*14+r]>0){
      genMelds(cnt,s,r,w,(list,u,type)=>{
        const v=pairsFromCnt(minus(cnt,list),w-u).pairs*2+list.length+u;
        if(v>bestV){ bestV=v; bestM={list,u,type}; }
      });
    }
    const pool=cards.slice(), groups=[];
    if(bestM) groups.push({cards:pullMeld(pool,bestM),kind:'meld'});
    const pr=pairArrange(pool);
    // okeyleri en büyük tek kartlarla çift yap
    let rest=pr.rest.slice(); const wl=rest.filter(isWild); rest=rest.filter(c=>!isWild(c));
    rest.sort((a,b)=>cardVal(eff(b).r)-cardVal(eff(a).r));
    const extra=[];
    while(wl.length && rest.length) extra.push({cards:[rest.shift(),wl.shift()],kind:'pair'});
    return {groups:[...groups,...pr.groups,...extra],rest:[...rest.sort(cmpRun),...wl]};
  }
  /* eşsiz kart toplamı (eşik aramadan, en iyi per + çift ya da sadece çift) */
  function ciftSumAny(cards){
    const {cnt,w}=toCnt(cards);
    let best=pairsFromCnt(cnt,w).sum;
    for(let r=1;r<=13;r++) for(let s=0;s<4;s++) if(cnt[s*14+r]>0){
      genMelds(cnt,s,r,w,(list,u)=>{ const x=pairsFromCnt(minus(cnt,list),w-u).sum; if(x<best) best=x; });
    }
    return best;
  }
  function pairArrange(cards){
    const pool=cards.slice(), groups=[];
    const used=new Set();
    for(const c of pool.slice().sort(cmpRun)){
      if(used.has(c.id)||isWild(c)) continue;
      const mate=pool.find(o=>o.id!==c.id&&!used.has(o.id)&&!isWild(o)&&eff(o).s===eff(c).s&&eff(o).r===eff(c).r);
      if(mate){ used.add(c.id); used.add(mate.id); groups.push({cards:[c,mate],kind:'pair'}); }
    }
    return {groups,rest:pool.filter(c=>!used.has(c.id)).sort(cmpRun)};
  }
  /* çift sayımı: tam çiftler, eşi olmayan kartlar (değerleri), okey sayısı */
  function pairInfo(cards){
    const m=new Map(); let w=0;
    for(const c of cards){ if(isWild(c)){w++;continue;} const e=eff(c), k=e.s*14+e.r; m.set(k,(m.get(k)||0)+1); }
    let pairs=0; const singles=[];
    for(const [k,v] of m){ pairs+=Math.floor(v/2); if(v%2) singles.push(cardVal(k%14)); }
    return {pairs,singles,w};
  }
  /* çifte gidip bitemeyenin elde kalanı: eşsiz kartlar, okeyler en büyüklerini kapatır */
  function pairLeftover(cards){
    const {singles,w}=pairInfo(cards);
    singles.sort((a,b)=>b-a);
    return singles.slice(w).reduce((a,b)=>a+b,0);
  }
  function pairValue(cards){
    const {pairs,singles,w}=pairInfo(cards);
    const cover=Math.min(w,singles.length);
    return (pairs+cover)*10 + (w-cover)*8 - singles.reduce((a,b)=>a+b,0)/100;
  }
  /* el sonunda çifte gitmiş mi: en az bir per + 4 çift ya da 5 çift. Elde kalan eşsiz kartların toplamını da verir */
  function pairsFromCnt(cnt,w){
    let pairs=0; const singles=[];
    for(let i=0;i<56;i++){ const v=cnt[i]; if(!v) continue; pairs+=Math.floor(v/2); if(v%2) singles.push(cardVal(i%14)); }
    singles.sort((a,b)=>b-a);
    const cover=Math.min(w,singles.length);
    return {pairs:pairs+cover+Math.floor((w-cover)/2), sum:singles.slice(cover).reduce((a,b)=>a+b,0)};
  }
  function wentCift(cards){
    const {cnt,w}=toCnt(cards);
    let best=null;
    const pure=pairsFromCnt(cnt,w);
    if(pure.pairs>=5) best=pure.sum;
    for(let r=1;r<=13;r++) for(let s=0;s<4;s++) if(cnt[s*14+r]>0){
      genMelds(cnt,s,r,w,(list,u)=>{
        const x=pairsFromCnt(minus(cnt,list),w-u);
        if(x.pairs>=4 && (best===null||x.sum<best)) best=x.sum;
      });
    }
    return best===null?null:best;
  }
  function wantsCift(cards){
    const {pairs}=pairInfo(cards);
    const covered=arrange(cards).groups.reduce((a,g)=>a+g.cards.length,0);
    return pairs>=4 && pairs*2>covered;
  }

  return {okey:S.okey, indicator, isWild, eff, cname, isIndicator, canWin, winType, score, leftover,
          wentCift, ciftSumAny, pairValue, wantsCift, arrange, makeDeck};
}

function makeDeck(){
  const d=[]; let id=0;
  for(let k=0;k<2;k++) for(let s=0;s<4;s++) for(let r=1;r<=13;r++) d.push({id:id++,s,r});
  d.push({id:id++,s:4,r:0}); d.push({id:id++,s:4,r:0});
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]];}
  return d;
}

module.exports={SUITS, SUIT_NAMES, MULT, cardVal, RL, createEngine, makeDeck};
