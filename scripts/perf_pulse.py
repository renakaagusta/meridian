import json, glob, sqlite3
def safe(fn, d=None):
    try: return fn()
    except Exception: return d
# LP
L = safe(lambda: json.load(open('/root/meridian/lessons.json'))['performance'], [])
lp_n = len(L); lp_pnl = sum((r.get('pnl_usd') or 0) for r in L)
S = safe(lambda: json.load(open('/root/meridian/state.json'))['positions'], {})
op = sum(1 for p in S.values() if not p.get('closed'))
# traces (screening cycles logged)
tr = safe(lambda: sum(1 for _ in open('/root/meridian/decision-traces.jsonl')), 0)
# latest counterfactual miss-rate
cf = '-'
cfs = sorted(glob.glob('/root/meridian/benchmark/counterfactual-*.json'))
if cfs: cf = str(safe(lambda: json.load(open(cfs[-1])).get('miss_rate_pct'), '-')) + '%'
# trade swaps (live trader dbs) + hunter health
def swaps(db):
    c = safe(lambda: sqlite3.connect(db), None)
    if not c: return 0
    rows = c.execute('SELECT content,tool_calls,tool_call_id FROM chat_messages').fetchall()
    cm=set()
    for content,tc,tcid in rows:
        if tc:
            try: arr=json.loads(tc)
            except: arr=[]
            for x in (arr if isinstance(arr,list) else []):
                if x.get('id') and (x.get('function') or {}).get('name')=='swap_token': cm.add(x['id'])
    n=0
    for content,tc,tcid in rows:
        if tcid in cm and content:
            try:
                if json.loads(content)['data'].get('success'): n+=1
            except: pass
    return n
sw = swaps('/root/meridian/../../evonic/agents/meridian_trader_screener/chat.db') if False else swaps('/root/evonic/agents/meridian_trader_screener/chat.db') + swaps('/root/evonic/agents/meridian_trader_manager/chat.db')
hn = safe(lambda: sqlite3.connect('/root/evonic/agents/meridian_trader_screener/chat.db').execute('SELECT count(*) FROM chat_messages').fetchone()[0], 0)
print(f'{lp_n},{op},{sw}||LP closed={lp_n} net=${lp_pnl:.0f} open={op} | trades={sw} | traces={tr} cf_miss={cf} | hunter_msgs={hn}')
