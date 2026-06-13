#!/bin/bash
# Proxy bandwidth + scraping health snapshot. Run on the meridian server.
WIN="${1:-20m}"
echo "===== SCRAPE MONITOR ($(date -u '+%Y-%m-%d %H:%M:%SZ') · window $WIN) ====="

echo "-- BANDWIDTH --"
# Note: DataImpulse /api/stats undercounts AND the cached /admin endpoint glitches
# (showed 100%/2.5GB while raw was 5GB). Neither is trustworthy — the DataImpulse
# DASHBOARD export is the only reliable byte measure. The real live drain signal is
# the GMGN routing section below (direct% = no residential; proxied/CF = drain returns).
echo "  (check the DataImpulse dashboard export for true bytes — /api/stats is unreliable)"

echo "-- SCRAPER ($WIN) success/error by type --"
docker logs --since "$WIN" stackbase-scraper 2>&1 \
 | grep -oE '"type":"[a-z-]+"[^}]*"msg":"[^"]*"' \
 | sed -E 's/.*"type":"([a-z-]+)".*"msg":"([a-zA-Z]+).*/\1 \2/' \
 | awk '{k=$1" "($2 ~ /success/?"success":($2 ~ /[Tt]imeout/?"timeout":($2 ~ /[Ee]rror|threw|fail/?"error":$2)));c[k]++} END{for(x in c)print "  "c[x]"\t"x}' \
 | sort -t$'\t' -k1 -rn | head -14

echo "-- DIRECT routing ($WIN) — home-IP flagging watch (issue #251) --"
# direct% dropping or proxied rising or CF challenges = home IP being CF-flagged
# (residential drain returns via fallback). Watched for both direct-first providers.
docker logs --since "$WIN" stackbase-scraper 2>&1 \
 | grep -E '"type":"(gmgn-web|birdeye-forge)"' \
 | python3 -c '
import sys
prov={"gmgn-web":[0,0,0,0],"birdeye-forge":[0,0,0,0]}  # direct,prox,other,cf
for ln in sys.stdin:
    k="gmgn-web" if "\"type\":\"gmgn-web\"" in ln else "birdeye-forge"
    if "\"msg\":\"success\"" in ln:
        if "nuc-id-direct" in ln: prov[k][0]+=1
        elif "nuc-id-proxied" in ln: prov[k][1]+=1
        else: prov[k][2]+=1
    if "cloudflare challenge" in ln.lower() or "Just a moment" in ln: prov[k][3]+=1
for k,(d,p,o,cf) in prov.items():
    tot=d+p+o; pct=round(100*d/tot) if tot else 0
    name=k.split("-")[0]
    if tot==0 and cf==0:
        print("  %-7s (no calls in window)"%name); continue
    warn=""
    if tot>=3 and pct<60: warn+="  ⚠️ DIRECT%% LOW — home IP may be CF-flagged"
    if cf>0: warn+="  ⚠️ CF CHALLENGES"
    print("  %-7s %d direct / %d proxied / %d other (direct %d%%) · cf=%d%s"%(name,d,p,o,pct,cf,warn))'

echo "-- CONTAINERS --"
docker ps --filter name=stackbase-scraper --format '  {{.Names}}: {{.Status}}'
