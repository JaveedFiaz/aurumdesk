import json, sys, time, urllib.request
sym, iv, start = sys.argv[1], sys.argv[2], int(sys.argv[3])
out = []; t = start * 1000
while True:
    url = f"https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval={iv}&limit=1000&startTime={t}"
    for k in range(5):
        try:
            rows = json.load(urllib.request.urlopen(url, timeout=30)); break
        except Exception as e:
            time.sleep(2 ** k)
    if not rows: break
    out += [[r[0] // 1000, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]), float(r[9])] for r in rows]
    t = rows[-1][0] + 1
    if len(rows) < 1000: break
    time.sleep(0.15)
json.dump(out, open(sys.argv[4], 'w'))
print(sym, iv, len(out), time.strftime('%Y-%m-%d', time.gmtime(out[0][0])), '->', time.strftime('%Y-%m-%d', time.gmtime(out[-1][0])))
