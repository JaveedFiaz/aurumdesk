# Pools research/meme-backtest.mjs results by strategy, timeframe and confluence gate.
# Usage: python meme-pool.py <results-dir>
import json, glob, collections, sys
rows=[]
for f in glob.glob(sys.argv[1]+'/*.json'):
    tf=f.split('.')[-2]
    for t in json.load(open(f)): t['tf']=tf; rows.append(t)
tmin=min(r['t'] for r in rows); tmax=max(r['t'] for r in rows)
out=[]
for (tf,s),g in sorted(collections.defaultdict(list,{}).items()): pass
groups=collections.defaultdict(list)
for r in rows: groups[(r['tf'],r['s'])].append(r)
for (tf,s),g in groups.items():
    span=(max(r['t'] for r in g if r['tf']==tf)-min(r['t'] for r in g if r['tf']==tf))
    split=min(r['t'] for r in g)+span*0.6
    for gate in (0,0.625,0.75):
        x=[r for r in g if r['f']/max(1,r['n'])>=gate-1e-9]
        if len(x)<60: continue
        R=[r['r'] for r in x]; w=sum(v for v in R if v>0); l=-sum(v for v in R if v<=0)
        ins=[r['r'] for r in x if r['t']<split]; oos=[r['r'] for r in x if r['t']>=split]
        bycoin=collections.defaultdict(float)
        for r in x: bycoin[r['coin']]+=r['r']
        days=(tmax-tmin)/86400 if tf=='M15' else 182
        out.append(dict(tf=tf,s=s,gate=gate,n=len(x),perDay=round(len(x)/days,2),win=round(sum(v>0 for v in R)/len(R),2),pf=round(w/l if l else 99,2),avg=round(sum(R)/len(R),3),tot=round(sum(R),1),is_=round(sum(ins)/max(1,len(ins)),2),oos=round(sum(oos)/max(1,len(oos)),2),coins=f"{sum(v>0 for v in bycoin.values())}/{len(bycoin)}"))
out.sort(key=lambda r:-r['avg'])
for r in out:
    if r['avg']>-0.02: print(r)
print(len(out),'groups')
