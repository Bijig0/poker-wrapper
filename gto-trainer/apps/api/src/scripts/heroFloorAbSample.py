"""
THE SAMPLE FOR THE HERO-FLOOR A/B (2026-10-14, docs/2026-10-14-hero-floor-ab.md; the harness is heroFloorAb.ts).

Reads the live records READ-ONLY (answers + the solves table's gzipped traces) and writes sample.json in the current
directory: every ai-chain decision since 2026-10-01 with hero's live mass / class mass / max weight on the decision
street, and the plan — tier 1 = every decision with hero under 5 combos (all of those hands' decisions, in order),
tier 2 = 20 random with 5-20 combos, tier 3 = 10 controls over 100 combos with no floor lift, from hands since 10-09.

    export PYTHONIOENCODING=utf-8; python -I heroFloorAbSample.py
"""
import sys; sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import sqlite3, json, gzip, collections, datetime, random
c=sqlite3.connect('file:C:/Users/Brady/poker-data/poker.sqlite?mode=ro',uri=True)
RANKS="23456789TJQKA"; SUITS="cdhs"
def cidx(card): return RANKS.index(card[0].upper())*4+SUITS.index(card[1].lower())
CC=[None]*1326
for b in range(1,52):
    for a in range(b): CC[b*(b-1)//2+a]=(a,b)
def classCombos(idx):
    a,b=CC[idx]; ra,rb=a//4,b//4; suited=(a%4==b%4); out=[]
    for s1 in range(4):
        for s2 in range(4):
            if ra==rb and s2<=s1: continue
            if ra!=rb and (s1==s2)!=suited: continue
            x,y=ra*4+s1,rb*4+s2
            if x==y: continue
            lo,hi=min(x,y),max(x,y); out.append(hi*(hi-1)//2+lo)
    return out
since=int(datetime.datetime(2026,10,1).timestamp()*1000)
rows=c.execute("select a.id,a.ts,a.client_hand_id,a.street,a.solve_id,a.pick,a.hero_cards,a.decision_json,a.session_id,a.hero_pos from answers a where a.tier='ai-chain' and a.ts >= ? and a.solve_id is not null order by a.ts",(since,)).fetchall()
def mass(rng,board,classSet):
    live=cls=0.0; mx=0; clsmax=0
    for i,w in enumerate(rng):
        if w<=0: continue
        a,b=CC[i]
        if a in board or b in board: continue
        live+=w; mx=max(mx,w)
        if i in classSet: cls+=w; clsmax=max(clsmax,w)
    return live,cls,mx,clsmax
out=[]
for aid,ts,cid,st,sid,pick,hc,dj,sess,hpos in rows:
    r=c.execute("select trace,origin,ok from solves where id=?",(sid,)).fetchone()
    if not r or r[2]!=1: continue
    tr=json.loads(gzip.decompress(r[0])); sp=tr['spec']
    hidx=sp.get('heroComboIdx')
    if hidx is None or not tr.get('result',{}).get('ok'): continue
    classSet=set(classCombos(hidx))
    streets=tr['streets']
    s=streets[-1]; players=s.get('players') or [sp['oopPos'],sp['ipPos']]
    heroPos={'oop':sp['oopPos'],'mid':sp.get('midPos'),'ip':sp['ipPos']}[sp['heroSeat']]
    hi=[i for i,p in enumerate(players) if p.upper()==heroPos.upper()]
    if not hi or not s.get('rangesIn'): continue
    hi=hi[0]
    board=set(cidx(x) for x in [s['board'][i:i+2] for i in range(0,len(s['board']),2)])
    live,cls,mx,clsmax=mass(s['rangesIn'][hi],board,classSet)
    # per street: did the floor bite (any class combo exactly 0.05 while the class max is 0.05)
    bites=[]
    for ss in streets:
        pl=ss.get('players') or [sp['oopPos'],sp['ipPos']]
        h=[i for i,p in enumerate(pl) if p.upper()==heroPos.upper()]
        if not h or not ss.get('rangesIn'): bites.append(None); continue
        b=set(cidx(x) for x in [ss['board'][i:i+2] for i in range(0,len(ss['board']),2)])
        l2,c2,m2,cm2=mass(ss['rangesIn'][h[0]],b,classSet)
        bites.append(abs(cm2-0.05)<1e-9)
    heroNode=[n for n in tr.get('nodes',[]) if n.get('heroNode')]
    hn=heroNode[-1] if heroNode else None
    hstrat=[(a['name'],a['strategy'][hidx] if hidx<len(a['strategy']) else None) for a in hn['actions']] if hn else None
    out.append(dict(answer=aid,ts=ts,hand=cid,street=st,solve=sid,pick=pick,hero=hc,heroPos=heroPos,session=sess,live=round(live,3),cls=round(cls,4),mx=round(mx,4),clsmax=round(clsmax,4),share=round(cls/live,4) if live else None,
        first=sp.get('firstStreet',0),plan=sp.get('planTag'),nStreets=len(streets),bites=bites,rangeSource=(sp.get('rangeSource') or '')[:60],
        traceHeroStrategy=hstrat,served=[(a['action'],round(a['frequency'],1)) for a in json.loads(dj)] if dj else None,
        answeredNarrow=sum(1 for n in tr.get('nodes',[]) if n.get('heroAnswered') and n['heroAnswered'].get('strategy')),
        heroNodeTaken=[n.get('fromCheckpoint',False) for n in heroNode]))
print(len(out),"ok decisions since 10-01")
t1=[d for d in out if d['live']<5]
t2pool=[d for d in out if 5<=d['live']<20]
t3pool=[d for d in out if d['live']>100]
random.seed(20261014)
hands1=sorted(set(d['hand'] for d in t1))
print("tier1 decisions",len(t1),"hands",len(hands1))
print("tier2 pool",len(t2pool),"hands",len(set(d['hand'] for d in t2pool)))
print("tier3 pool",len(t3pool))
t2=random.sample(t2pool,20)
# controls: 10 random with >100 and no floor bite anywhere
t3c=[d for d in t3pool if not any(d['bites']) and d['ts']>=int(datetime.datetime(2026,10,9).timestamp()*1000)]
t3=random.sample(t3c,10)
# by hand: for each sampled hand take ALL its decisions (walked in order)
sel={}
for d in t1: sel.setdefault(d['hand'],set()).add(('t1',d['answer']))
for d in t2: sel.setdefault(d['hand'],set()).add(('t2',d['answer']))
for d in t3: sel.setdefault(d['hand'],set()).add(('t3',d['answer']))
byhand=collections.defaultdict(list)
for d in out: byhand[d['hand']].append(d)
plan=[]
for h,tags in sel.items():
    tier=min(t for t,_ in tags)
    decs=sorted(byhand[h],key=lambda d:d['ts'])
    plan.append(dict(hand=h,tier=tier,decisions=decs,tagged=sorted(a for _,a in tags)))
plan.sort(key=lambda p:(p['tier'],p['decisions'][0]['ts']))
json.dump(dict(all=out,plan=plan),open('sample.json','w'),indent=0)
bite_streets=sum(sum(1 for b in p['decisions'][-1]['bites'] if b) for p in plan)
print("plan hands",len(plan),"decisions",sum(len(p['decisions']) for p in plan),"floor-bitten streets (last decision)",bite_streets)
for p in plan:
    d=p['decisions'][-1]
    print(p['tier'],p['hand'],len(p['decisions']),'dec',d['street'],d['hero'],d['heroPos'],'live',d['live'],'share',d['share'],'bites',d['bites'],'plan',d['plan'],'first',d['first'],'narrow',d['answeredNarrow'],d['rangeSource'][:30])
