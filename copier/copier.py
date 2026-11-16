"""Signal copier: WhatsApp/Telegram signal text -> trades on an Exness MT5 account.

Runs on a Windows PC (or Windows VPS) next to a logged-in MetaTrader 5 terminal.
Your Exness login stays inside MT5: this script never sees your password.

Signals arrive as text over HTTP (a phone app forwards each channel
notification, or you paste it on the page at http://localhost:8787):

    Sell Gold (3866.725)
    Stoploss at : 3876.725
    Tp1 : 3862.725
    ...
    Tp5 : 3846.725

Each signal opens one position per take-profit, sized so that the whole signal
risks `risk_pct` of equity at its stop. Safety: demo-only unless `live` is
true, skip if price moved too far from the signal, daily loss limit, maximum
open signals, duplicate filter, stop moved to entry once TP1 is reached.

Usage:  python copier.py [config.json]
"""

import csv
import datetime as dt
import hashlib
import html
import json
import math
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DEFAULTS = {
    "live": False,                 # True allows a REAL account; otherwise demo/contest only
    "symbols": ["XAUUSD", "XAUUSDm", "XAUUSDc", "XAUUSDz"],  # first one MT5 knows is used
    "risk_pct": 1.0,               # % of equity lost if every position hits the stop
    "fixed_lots_per_tp": 0,        # >0 ignores risk_pct and uses this volume per TP
    "use_tps": [1, 2, 3, 4, 5],    # which TPs get a position
    "max_slippage": 2.0,           # skip if price is further than this from the signal entry ($)
    "max_daily_loss_pct": 5.0,     # no new trades after equity falls this far below the day's start
    "max_open_signals": 2,         # signals with positions still open
    "breakeven_after_tp1": True,   # move the stop to entry once price reaches TP1
    "deviation_points": 50,        # allowed price deviation when the order is filled
    "magic": 880711,
    "host": "127.0.0.1",           # 0.0.0.0 to accept signals from your phone on the same Wi-Fi
    "port": 8787,
    "token": "",                   # required in requests when set (?token=... or X-Token header)
    "log_file": "copier_trades.csv",
}

NUM = r"(\d+(?:\.\d+)?)"
SIDE_RE = re.compile(r"\b(buy|sell)\b[^\d\n]*?(?:gold|xau\s*/?\s*usd)[^\d\n]*?" + NUM, re.I)
SL_RE = re.compile(r"\b(?:stop\s*-?\s*loss|sl)\b[^\d\n]*" + NUM, re.I)
TP_RE = re.compile(r"\btp\s*(\d)\b[^\d\n]*" + NUM, re.I)


def parse_signal(text):
    """Returns {side, entry, sl, tps} or None when the text is not a valid gold signal."""
    if not text:
        return None
    m = SIDE_RE.search(text)
    s = SL_RE.search(text)
    tps = {int(k): float(v) for k, v in TP_RE.findall(text)}
    if not m or not s or not tps:
        return None
    side = m.group(1).lower()
    entry = float(m.group(2))
    sl = float(s.group(1))
    targets = [tps[k] for k in sorted(tps)]
    if side == "sell":
        ok = sl > entry and all(t < entry for t in targets)
    else:
        ok = sl < entry and all(t > entry for t in targets)
    if not ok:
        return None
    return {"side": side, "entry": entry, "sl": sl, "tps": targets, "tp_ids": sorted(tps)}


def plan_volumes(total, n, vmin, vstep, vmax):
    """Splits `total` lots over up to n legs, as evenly as the lot step allows (the
    nearer TPs get any extra step). Drops the far TPs when there is not enough
    volume for each leg to reach the minimum lot."""
    steps = int(math.floor(total / vstep + 1e-9))
    min_steps = int(math.ceil(vmin / vstep - 1e-9))
    legs = min(n, steps // min_steps) if min_steps else 0
    if legs <= 0:
        return []
    base, extra = divmod(steps, legs)
    return [round(min((base + (1 if i < extra else 0)) * vstep, vmax), 8) for i in range(legs)]


def lots_for_risk(risk_cash, entry, sl, tick_value, tick_size):
    loss_per_lot = abs(entry - sl) / tick_size * tick_value
    return risk_cash / loss_per_lot if loss_per_lot > 0 else 0.0


class Copier:
    def __init__(self, mt5, cfg, now=time.time):
        self.mt5 = mt5
        self.cfg = {**DEFAULTS, **cfg}
        self.now = now
        self.lock = threading.Lock()
        self.seen = {}        # signal hash -> time
        self.groups = {}      # group id -> {sig, symbol, tickets, be_done}
        self.day = None
        self.day_start_equity = None
        self.symbol = None
        self.events = []

    # ---- helpers -------------------------------------------------------------
    def note(self, msg):
        line = f"{dt.datetime.now().strftime('%H:%M:%S')} {msg}"
        print(line, flush=True)
        self.events.insert(0, line)
        del self.events[60:]

    def log_trade(self, row):
        path = self.cfg["log_file"]
        new = not os.path.exists(path)
        with open(path, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["time", "group", "side", "symbol", "volume", "price", "sl", "tp", "ticket", "result"])
            w.writerow(row)

    def resolve_symbol(self):
        if self.symbol:
            return self.symbol
        for s in self.cfg["symbols"]:
            if self.mt5.symbol_select(s, True) and self.mt5.symbol_info(s):
                self.symbol = s
                return s
        return None

    def filling(self, info):
        mode = getattr(info, "filling_mode", 0)
        if mode & 1:
            return self.mt5.ORDER_FILLING_FOK
        if mode & 2:
            return self.mt5.ORDER_FILLING_IOC
        return self.mt5.ORDER_FILLING_RETURN

    def open_groups(self):
        positions = self.mt5.positions_get() or []
        mine = {p.ticket for p in positions if p.magic == self.cfg["magic"]}
        return {g: v for g, v in self.groups.items() if any(t in mine for t in v["tickets"])}

    def daily_guard(self, acct):
        today = dt.datetime.utcnow().date()
        if self.day != today:
            self.day = today
            self.day_start_equity = acct.equity
        limit = self.day_start_equity * (1 - self.cfg["max_daily_loss_pct"] / 100)
        return acct.equity > limit

    # ---- a new signal ------------------------------------------------------------
    def handle(self, text):
        with self.lock:
            return self._handle(text)

    def _handle(self, text):
        sig = parse_signal(text)
        if not sig:
            return {"ok": False, "reason": "Not a gold signal (need Buy/Sell Gold price, Stoploss and TPs)"}
        key = hashlib.sha1(f"{sig['side']}|{sig['entry']}|{sig['sl']}".encode()).hexdigest()
        t = self.now()
        self.seen = {k: v for k, v in self.seen.items() if t - v < 6 * 3600}
        if key in self.seen:
            return {"ok": False, "reason": "Duplicate signal ignored"}
        self.seen[key] = t
        name = f"{sig['side'].upper()} {sig['entry']}"

        acct = self.mt5.account_info()
        if acct is None:
            return self.skip(name, "MT5 is not connected (open MetaTrader 5 and log in)")
        if acct.trade_mode == self.mt5.ACCOUNT_TRADE_MODE_REAL and not self.cfg["live"]:
            return self.skip(name, 'This is a REAL account and "live" is false in config.json')
        if not self.daily_guard(acct):
            return self.skip(name, f"Daily loss limit of {self.cfg['max_daily_loss_pct']}% reached")
        if len(self.open_groups()) >= self.cfg["max_open_signals"]:
            return self.skip(name, f"{self.cfg['max_open_signals']} signals already open")
        sym = self.resolve_symbol()
        if not sym:
            return self.skip(name, f"None of the symbols {self.cfg['symbols']} exist on this account")
        info = self.mt5.symbol_info(sym)
        tick = self.mt5.symbol_info_tick(sym)
        if not info or not tick:
            return self.skip(name, f"No price for {sym}")

        sell = sig["side"] == "sell"
        price = tick.bid if sell else tick.ask
        if abs(price - sig["entry"]) > self.cfg["max_slippage"]:
            return self.skip(name, f"Price {price} is more than ${self.cfg['max_slippage']} from the entry")
        if (sell and price >= sig["sl"]) or (not sell and price <= sig["sl"]):
            return self.skip(name, "Price is already beyond the stop")

        legs = [(i, tp) for i, tp in zip(sig["tp_ids"], sig["tps"]) if i in self.cfg["use_tps"]]
        legs = [(i, tp) for i, tp in legs if (tp < price if sell else tp > price)]
        if not legs:
            return self.skip(name, "Price is already past the take-profits")

        if self.cfg["fixed_lots_per_tp"] > 0:
            vols = [self.cfg["fixed_lots_per_tp"]] * len(legs)
        else:
            risk_cash = acct.equity * self.cfg["risk_pct"] / 100
            total = lots_for_risk(risk_cash, price, sig["sl"], info.trade_tick_value, info.trade_tick_size)
            vols = plan_volumes(total, len(legs), info.volume_min, info.volume_step, info.volume_max)
            if not vols:
                return self.skip(name, f"Risk ${risk_cash:.2f} is too small for the minimum lot {info.volume_min}")
            legs = legs[: len(vols)]

        gid = key[:8]
        tickets = []
        for (i, tp), vol in zip(legs, vols):
            req = {
                "action": self.mt5.TRADE_ACTION_DEAL,
                "symbol": sym,
                "volume": vol,
                "type": self.mt5.ORDER_TYPE_SELL if sell else self.mt5.ORDER_TYPE_BUY,
                "price": price,
                "sl": sig["sl"],
                "tp": tp,
                "deviation": self.cfg["deviation_points"],
                "magic": self.cfg["magic"],
                "comment": f"sig {gid} tp{i}",
                "type_time": self.mt5.ORDER_TIME_GTC,
                "type_filling": self.filling(info),
            }
            r = self.mt5.order_send(req)
            done = r is not None and r.retcode == self.mt5.TRADE_RETCODE_DONE
            ticket = getattr(r, "order", 0) if done else 0
            if done:
                tickets.append(ticket)
            self.log_trade([dt.datetime.now().isoformat(timespec="seconds"), gid, sig["side"], sym, vol, price, sig["sl"], tp, ticket,
                            "filled" if done else f"rejected {getattr(r, 'retcode', None)} {getattr(r, 'comment', '')}"])
        if not tickets:
            return self.skip(name, "Every order was rejected (see copier_trades.csv)")
        self.groups[gid] = {"sig": sig, "symbol": sym, "tickets": tickets, "be_done": False}
        self.note(f"OPENED {name} on {sym}: {len(tickets)} position(s), {sum(vols):.2f} lots in total, SL {sig['sl']}")
        return {"ok": True, "group": gid, "positions": len(tickets), "volumes": vols, "symbol": sym}

    def skip(self, name, reason):
        self.note(f"SKIPPED {name}: {reason}")
        return {"ok": False, "reason": reason}

    # ---- trade management (every couple of seconds) ------------------------------
    def manage(self):
        with self.lock:
            if not self.cfg["breakeven_after_tp1"]:
                return
            positions = {p.ticket: p for p in (self.mt5.positions_get() or []) if p.magic == self.cfg["magic"]}
            for gid, g in list(self.groups.items()):
                live = [positions[t] for t in g["tickets"] if t in positions]
                if not live:
                    del self.groups[gid]
                    continue
                if g["be_done"]:
                    continue
                sig = g["sig"]
                tick = self.mt5.symbol_info_tick(g["symbol"])
                if not tick:
                    continue
                sell = sig["side"] == "sell"
                reached = tick.ask <= sig["tps"][0] if sell else tick.bid >= sig["tps"][0]
                if not reached:
                    continue
                for p in live:
                    self.mt5.order_send({"action": self.mt5.TRADE_ACTION_SLTP, "symbol": g["symbol"], "position": p.ticket,
                                         "sl": p.price_open, "tp": p.tp, "magic": self.cfg["magic"]})
                g["be_done"] = True
                self.note(f"TP1 reached on {sig['side'].upper()} {sig['entry']}: stops moved to entry")


PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal copier</title><style>body{{font:15px system-ui;background:#120a2a;color:#f4f1ff;margin:0;padding:16px;max-width:760px}}
textarea{{width:100%;height:170px;background:#1e1440;color:#fff;border:1px solid #4b3d80;border-radius:10px;padding:10px;font:14px monospace;box-sizing:border-box}}
button{{margin-top:8px;padding:10px 18px;border:0;border-radius:10px;background:#16c784;color:#06150e;font-weight:700}}
pre{{background:#1e1440;padding:10px;border-radius:10px;white-space:pre-wrap}}.warn{{color:#ffd27a}}</style></head><body>
<h2>Signal copier</h2><p>{mode}</p><form method="post" action="/signal{tok}"><textarea name="text" placeholder="Paste a signal"></textarea><br>
<button>Send to MT5</button></form><h3>Activity</h3><pre>{events}</pre></body></html>"""


def make_handler(copier, mt5):
    class Handler(BaseHTTPRequestHandler):
        def _authorized(self, q):
            tok = copier.cfg["token"]
            return not tok or q.get("token", [""])[0] == tok or self.headers.get("X-Token") == tok

        def _send(self, code, body, ctype="application/json"):
            data = body.encode() if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if not self._authorized(q):
                return self._send(401, '{"error":"bad token"}')
            acct = mt5.account_info()
            if acct is None:
                mode = '<b class="warn">MT5 not connected</b>'
            else:
                real = acct.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL
                mode = f"Account {acct.login} · {'REAL' if real else 'DEMO'} · equity {acct.equity:.2f} {acct.currency}"
                if real and not copier.cfg["live"]:
                    mode += ' · <b class="warn">real account: trading blocked until "live": true</b>'
            tok = f"?token={copier.cfg['token']}" if copier.cfg["token"] else ""
            page = PAGE.format(mode=mode, tok=tok, events=html.escape("\n".join(copier.events) or "No signals yet"))
            return self._send(200, page, "text/html; charset=utf-8")

        def do_POST(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path != "/signal":
                return self._send(404, '{"error":"not found"}')
            if not self._authorized(q):
                return self._send(401, '{"error":"bad token"}')
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0)).decode("utf-8", "replace")
            ctype = self.headers.get("Content-Type", "")
            if "json" in ctype:
                try:
                    text = json.loads(raw).get("text", "")
                except ValueError:
                    text = ""
            elif "form" in ctype:
                text = parse_qs(raw).get("text", [""])[0]
            else:
                text = raw
            res = copier.handle(text)
            if "form" in ctype:
                self.send_response(303)
                self.send_header("Location", "/" + (f"?token={copier.cfg['token']}" if copier.cfg["token"] else ""))
                self.end_headers()
                return None
            return self._send(200, json.dumps(res))

        def log_message(self, *a):
            pass

    return Handler


def main():
    import MetaTrader5 as mt5  # Windows only: pip install MetaTrader5

    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    cfg = json.load(open(path)) if os.path.exists(path) else {}
    if not mt5.initialize():
        print("Could not connect to MetaTrader 5. Open MT5, log in to Exness, enable Algo Trading, then retry.")
        print(mt5.last_error())
        sys.exit(1)
    copier = Copier(mt5, cfg)
    acct = mt5.account_info()
    real = acct and acct.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL
    print(f"Connected: account {acct.login if acct else '?'} ({'REAL' if real else 'DEMO'}), symbol {copier.resolve_symbol()}")
    if real and not copier.cfg["live"]:
        print('REAL account detected: signals will be skipped until you set "live": true in config.json.')

    def loop():
        while True:
            try:
                copier.manage()
            except Exception as e:  # keep managing even if one pass fails
                print("manage error:", e)
            time.sleep(2)

    threading.Thread(target=loop, daemon=True).start()
    srv = ThreadingHTTPServer((copier.cfg["host"], copier.cfg["port"]), make_handler(copier, mt5))
    print(f"Paste signals at http://localhost:{copier.cfg['port']}  (POST text to /signal)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
