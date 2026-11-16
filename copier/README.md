# Signal copier for Exness (MT5)

Copies gold signals like this one onto your Exness MetaTrader 5 account:

```
Sell Gold (3866.725)
Stoploss at : 3876.725
Tp1 : 3862.725   ...   Tp5 : 3846.725
```

Each signal opens **one position per TP** (5 positions), each with the signal's
stop, sized so the whole signal risks **1% of your equity** at the stop. When
price reaches TP1, the stops of the remaining positions move to entry.

Your Exness password stays in MetaTrader 5. This script only talks to the MT5
terminal already open and logged in on the same PC.

## Safety rules (config.json)

| Setting | Default | What it does |
|---|---|---|
| `live` | `false` | A **real** account is refused until you set this to `true`. Demo works straight away. |
| `risk_pct` | `1.0` | % of equity lost if every position hits the stop |
| `fixed_lots_per_tp` | `0` | Set e.g. `0.01` to use a fixed size per TP instead of `risk_pct` |
| `use_tps` | `[1,2,3,4,5]` | Which TPs get a position (e.g. `[1,2,3]`) |
| `max_slippage` | `2.0` | Skip the signal if price is more than $2 from its entry |
| `max_daily_loss_pct` | `5.0` | No new trades after equity is 5% below the day's start (UTC) |
| `max_open_signals` | `2` | At most 2 signals open at once |
| `breakeven_after_tp1` | `true` | Move stops to entry once TP1 is reached |
| `symbols` | XAUUSD, XAUUSDm, ... | Exness gold symbol names; the first one on your account is used |
| `feed_url` | empty | Pulse Scalper signal feed to follow (see below) |
| `token` | empty | Set a password-like value when phones send signals over Wi-Fi |

Duplicate signals (same side, entry and stop within 6 hours) are ignored. Every
order is written to `copier_trades.csv`.

## Set up (Windows PC or Windows VPS)

1. Install **MetaTrader 5** from Exness, log in to your account (start with a **demo** account),
   and turn on **Algo Trading** (the button in the toolbar must be green).
2. Install **Python 3.10+** from python.org (tick "Add Python to PATH").
3. Download this `copier` folder, open a terminal in it and run `pip install -r requirements.txt`.
4. Double-click **start.bat** (it creates `config.json` from the example the first time).
5. Open http://localhost:8787, paste a signal and press **Send to MT5**.

Keep the PC (and MT5) running while you want signals copied. A Windows VPS
(about $5-10 a month) keeps it running 24/7.

## Trading the terminal's own signals (no WhatsApp needed)

The Pulse Scalper server publishes every new setup from its proven strategies at
`/api/signals`. Set in `config.json`:

```
"feed_url": "https://aurumdesk-zhni.onrender.com/api/signals?market=gold"
```

and the copier polls it every 3 seconds and trades each new gold setup: one
position with the strategy's own stop and target (its backtests did better with
a single target than with split TPs and stop-to-entry). Only setups published
after the copier starts are traded. You can use the feed and WhatsApp signals at
the same time.

## Getting signals from the WhatsApp channel automatically

WhatsApp has no official way for programs to read a channel. The reliable route
is your Android phone forwarding the channel's notifications:

1. In `config.json` set `"host": "0.0.0.0"` and a `"token"` such as `"k8s2-gold"`, then restart.
   Allow Python through Windows Firewall when asked. Find the PC's address with `ipconfig` (e.g. 192.168.1.20).
2. On the phone, install **MacroDroid** (free) and create a macro:
   - Trigger: **Notification received** → app WhatsApp → text contains `Stoploss`
   - Action: **HTTP request** → POST to `http://192.168.1.20:8787/signal?token=k8s2-gold`,
     body = the notification text (`[notification]`), content type `text/plain`.
3. Turn on notifications for the channel in WhatsApp, then test by pasting an old signal into a chat with yourself.

The phone and PC must be on the same Wi-Fi. For a VPS, use a tunnel such as
Tailscale (free) instead of opening the port to the internet.

Programs that log in to WhatsApp Web to read messages break WhatsApp's terms and
can get the number banned, so they are not used here.

## Test without MT5

```
cd copier
python -m unittest test_copier
```

## Risks

Signals with a fixed $10 stop and $4 targets lose money in choppy markets, and
slippage at news times can make losses bigger than planned. Run it on demo first,
then start live with `risk_pct` 0.25-0.5. Not financial advice.
