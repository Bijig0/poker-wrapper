/**
 * The console reader and its payload parser — ported from the dashboard app's
 * lib/liveImport.ts.
 *
 * The snippet is pasted into the Ignition table's own devtools console; it
 * prints a payload that `parseLivePayload` turns into a spot the replica can
 * draw. It only reads — it never clicks, types, or sends anything.
 */
import { SEAT_MAPS } from "./table-spec.js";

/**
 * Each seat carries its rendered design-space position. That matters: the
 * client keeps hero at (343,290) and rotates everyone else around them, so the
 * mapping from the client's seat number to a screen slot changes whenever you
 * change seats. Matching on position sidesteps the rotation entirely.
 */
export const LIVE_READER_SNIPPET = String.raw`(()=>{const S=["c","d","h","s"],R=["A","2","3","4","5","6","7","8","9","T","J","Q","K"];
const dec=i=>(i<0||i>51)?null:R[i%13]+S[(i/13)|0];
const num=s=>{if(!s)return null;const m=String(s).replace(/,/g,'').match(/-?\d+(\.\d+)?/);return m?+m[0]:null};
const fb=e=>{const k=Object.keys(e).find(x=>x.startsWith('__reactInternalInstance$')||x.startsWith('__reactFiber$'));return k?e[k]:null};
const rp=(e,key)=>{let f=fb(e),n=0;while(f&&n<10){const p=f.memoizedProps;
if(p&&typeof p==='object'&&key in p)return p[key];f=f.return;n++}return null};
let d=null;for(let i=0;i<frames.length;i++){try{const x=frames[i].document;
if(x.querySelector("[data-qa^='playerContainer-']")){d=x;break}}catch(e){}}
if(!d)return"no table frame — open a table first";
const zoomOf=e=>{while(e){const z=parseFloat(getComputedStyle(e).zoom);if(z&&z!==1)return z;e=e.parentElement}return 1};
const ids=r=>{const o=[];for(const e of r.querySelectorAll("[data-qa^='card']")){
const m=e.getAttribute('data-qa').match(/^card(-?\d+)$/);if(!m)continue;const i=+m[1];
if(i<0||i>51)continue;if(!o.includes(i))o.push(i)}return o};
const t=q=>{const e=d.querySelector("[data-qa='"+q+"']");return e?e.textContent.trim():null};
const sEls=[...d.querySelectorAll("[data-qa^='playerContainer-']")];
const seatIds=new Set(sEls.flatMap(s=>ids(s)));
const board=ids(d.querySelector("[data-qa='table']")||d).filter(i=>!seatIds.has(i)).map(dec);
const seats=sEls.map(el=>{const i=+el.getAttribute('data-qa').split('-')[1];
let p=el,box=null;while(p){if(getComputedStyle(p).position==='absolute'&&p.offsetWidth>100&&p.offsetWidth<200){box=p;break}p=p.parentElement}
const cs=box?getComputedStyle(box):null;
const lab=(el.textContent||'').replace(/\.[\w-]+\{[^}]*\}/g,'');
const a=lab.match(/\b(FOLD|CHECK|CALL|BET|RAISE|ALL-?IN|POST SB|POST BB)\b/i);
const bal=el.querySelector("[data-qa='playerBalance']");
return{seat:i,x:cs?Math.round(parseFloat(cs.left)):null,y:cs?Math.round(parseFloat(cs.top)):null,
stackBB:num(bal&&bal.textContent),action:a?a[1].toUpperCase():null,
acting:rp(el,'isTheActivePlayer')===true,
isHero:!!el.querySelector("[data-qa='myPlayerTag']"),cards:ids(el).map(dec)}});
const st=[...d.querySelectorAll('div,span')].filter(e=>!e.children.length&&
/^(high card|pair|two pair|three of|straight|flush|full house|four of)/i.test((e.textContent||'').trim()))
.map(e=>e.textContent.trim())[0]||null;
const out={capacity:sEls.length,potBB:num(t('totalPot')),board,seats,handStrength:st,
actions:['foldButton','callButton','raiseButton'].map(t).filter(Boolean)};
console.log('%c--- copy the line below ---','color:#0c9');console.log(JSON.stringify(out));
try{copy(JSON.stringify(out));console.log('%ccopied to clipboard','color:#0c9')}catch(e){}
return out})()`;

/**
 * Convert a live payload into a spot, mapping each seat onto the screen slot
 * whose measured origin it sits closest to.
 */
export function parseLivePayload(json) {
  const p = JSON.parse(json);
  if (!p.seats?.length) throw new Error("payload has no seats");

  const capacity = p.seats.length === 9 ? 9 : 6;
  const map = SEAT_MAPS[capacity];

  const nearestSlot = (x, y) => {
    if (x == null || y == null) return null;
    let best = -1;
    let bestD = Infinity;
    map.forEach((o, i) => {
      const dd = (o.x - x) ** 2 + (o.y - y) ** 2;
      if (dd < bestD) { bestD = dd; best = i; }
    });
    // Origins are ~100du apart; anything further out is not a seat position.
    return bestD <= 60 * 60 ? best : null;
  };

  const taken = new Set();
  const seats = [];

  p.seats.forEach((s, idx) => {
    let slot = nearestSlot(s.x, s.y);
    if (slot == null || taken.has(slot)) {
      // Fall back to declaration order for anything unplaceable.
      slot = map.findIndex((_, i) => !taken.has(i));
      if (slot < 0) slot = idx % map.length;
    }
    taken.add(slot);

    const cards = (s.cards ?? []).filter(Boolean);
    const hasStack = s.stackBB != null;
    seats.push({
      slot,
      status: !hasStack ? "empty"
        : s.acting ? "acting"
        : s.action === "FOLD" ? "folded"
        : "active",
      seatNo: s.seat,
      stackBB: s.stackBB ?? undefined,
      action: s.action ?? undefined,
      cards,
      isHero: s.isHero || undefined,
    });
  });

  return {
    capacity,
    potBB: p.potBB ?? undefined,
    board: (p.board ?? []).filter(Boolean),
    seats,
    handStrength: p.handStrength ?? undefined,
    actions: p.actions?.length ? { buttons: p.actions } : undefined,
  };
}
