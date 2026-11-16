"""Tests with a fake MetaTrader5 module.  Run: python -m unittest copier/test_copier.py"""

import os
import sys
import tempfile
import unittest
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from copier import Copier, parse_signal, plan_volumes, lots_for_risk  # noqa: E402

SIGNAL = """Sell Gold (3866.725)
🔴Stoploss at : 3876.725
🟢Tp1 : 3862.725
🟢Tp2 : 3858.725
🟢Tp3 : 3854.725
🟢Tp4 : 3850.725
🟢Tp5 : 3846.725
© FAP AI INDICATOR | Join us for more signals"""


class FakeMT5:
    ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_CONTEST, ACCOUNT_TRADE_MODE_REAL = 0, 1, 2
    TRADE_ACTION_DEAL, TRADE_ACTION_SLTP = 1, 6
    ORDER_TYPE_BUY, ORDER_TYPE_SELL = 0, 1
    ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
    ORDER_TIME_GTC = 0
    TRADE_RETCODE_DONE = 10009

    def __init__(self, bid=3866.5, ask=3866.7, equity=10000.0, mode=0):
        self.acct = NS(login=1, equity=equity, currency="USD", trade_mode=mode)
        self.tick = NS(bid=bid, ask=ask)
        # Exness gold: 1 lot = 100 oz, so $1 move = $100 per lot.
        self.info = NS(trade_tick_value=1.0, trade_tick_size=0.01, volume_min=0.01, volume_step=0.01, volume_max=200, filling_mode=1)
        self.sent = []
        self.positions = []
        self.next = 100

    def account_info(self):
        return self.acct

    def symbol_select(self, s, on):
        return s == "XAUUSDm"

    def symbol_info(self, s):
        return self.info if s == "XAUUSDm" else None

    def symbol_info_tick(self, s):
        return self.tick

    def positions_get(self):
        return self.positions

    def order_send(self, req):
        self.sent.append(req)
        if req["action"] == self.TRADE_ACTION_DEAL:
            self.next += 1
            self.positions.append(NS(ticket=self.next, magic=req["magic"], price_open=req["price"], tp=req["tp"], sl=req["sl"]))
            return NS(retcode=self.TRADE_RETCODE_DONE, order=self.next, comment="done")
        return NS(retcode=self.TRADE_RETCODE_DONE, order=0, comment="done")


class CopierTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.log = os.path.join(self.tmp, "log.csv")

    def make(self, mt5=None, **cfg):
        mt5 = mt5 or FakeMT5()
        return Copier(mt5, {"log_file": self.log, **cfg}), mt5

    def test_parses_the_channel_format(self):
        s = parse_signal(SIGNAL)
        self.assertEqual(s["side"], "sell")
        self.assertEqual(s["entry"], 3866.725)
        self.assertEqual(s["sl"], 3876.725)
        self.assertEqual(s["tps"], [3862.725, 3858.725, 3854.725, 3850.725, 3846.725])
        buy = parse_signal("BUY GOLD 3850.5\nSL 3840.5\nTP1 3854.5\nTP2: 3858.5")
        self.assertEqual((buy["side"], buy["sl"], buy["tps"]), ("buy", 3840.5, [3854.5, 3858.5]))
        self.assertIsNone(parse_signal("Gold is looking bullish today"))
        self.assertIsNone(parse_signal("Sell Gold 3866\nStoploss 3856\nTp1 3862"))  # stop on the wrong side

    def test_sizing_risks_the_chosen_percent(self):
        # $100 risk, $10 stop, $100 per lot per $1 -> 0.10 lots total
        self.assertAlmostEqual(lots_for_risk(100, 3866.7, 3876.7, 1.0, 0.01), 0.1, places=6)
        self.assertEqual(plan_volumes(0.1, 5, 0.01, 0.01, 100), [0.02] * 5)
        self.assertEqual(plan_volumes(0.03, 5, 0.01, 0.01, 100), [0.01] * 3)  # far TPs dropped
        self.assertEqual(plan_volumes(0.0978, 5, 0.01, 0.01, 100), [0.02, 0.02, 0.02, 0.02, 0.01])
        self.assertEqual(plan_volumes(0.004, 5, 0.01, 0.01, 100), [])

    def test_opens_one_position_per_tp_on_demo(self):
        c, mt5 = self.make()
        r = c.handle(SIGNAL)
        self.assertTrue(r["ok"], r)
        deals = [s for s in mt5.sent if s["action"] == mt5.TRADE_ACTION_DEAL]
        self.assertEqual(len(deals), 5)
        self.assertTrue(all(d["type"] == mt5.ORDER_TYPE_SELL and d["sl"] == 3876.725 and d["symbol"] == "XAUUSDm" for d in deals))
        self.assertEqual([d["tp"] for d in deals], [3862.725, 3858.725, 3854.725, 3850.725, 3846.725])
        # 1% of $10,000 over a $10.225 stop (sold at 3866.5): 0.0978 lots -> 0.09 in 5 legs
        self.assertEqual([d["volume"] for d in deals], [0.02, 0.02, 0.02, 0.02, 0.01])
        self.assertTrue(os.path.exists(self.log))

    def test_duplicate_is_ignored(self):
        c, mt5 = self.make()
        c.handle(SIGNAL)
        r = c.handle(SIGNAL)
        self.assertFalse(r["ok"])
        self.assertIn("Duplicate", r["reason"])

    def test_real_account_blocked_unless_live(self):
        c, mt5 = self.make(FakeMT5(mode=2))
        r = c.handle(SIGNAL)
        self.assertFalse(r["ok"])
        self.assertIn("REAL", r["reason"])
        self.assertEqual(mt5.sent, [])
        c2, mt52 = self.make(FakeMT5(mode=2), live=True)
        self.assertTrue(c2.handle(SIGNAL)["ok"])

    def test_skips_when_price_moved_too_far(self):
        c, mt5 = self.make(FakeMT5(bid=3860.0, ask=3860.2))
        r = c.handle(SIGNAL)
        self.assertFalse(r["ok"])
        self.assertIn("more than", r["reason"])
        self.assertEqual(mt5.sent, [])

    def test_daily_loss_limit_and_max_open(self):
        c, mt5 = self.make(max_open_signals=1)
        self.assertTrue(c.handle(SIGNAL)["ok"])
        r = c.handle(SIGNAL.replace("3866.725", "3866.825"))
        self.assertIn("already open", r["reason"])
        c2, mt52 = self.make()
        c2.handle("Buy Gold 3866.6\nSL 3856.6\nTP1 3870.6")  # sets the day's starting equity
        mt52.acct.equity = 9400
        r = c2.handle(SIGNAL)
        self.assertIn("Daily loss", r["reason"])

    def test_moves_stop_to_entry_after_tp1(self):
        c, mt5 = self.make()
        c.handle(SIGNAL)
        mt5.tick = NS(bid=3862.5, ask=3862.7)
        c.manage()
        mods = [s for s in mt5.sent if s["action"] == mt5.TRADE_ACTION_SLTP]
        self.assertEqual(len(mods), 5)
        self.assertTrue(all(m["sl"] == 3866.5 for m in mods))
        c.manage()
        self.assertEqual(len([s for s in mt5.sent if s["action"] == mt5.TRADE_ACTION_SLTP]), 5)  # only once


if __name__ == "__main__":
    unittest.main()
