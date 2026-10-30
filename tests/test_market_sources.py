"""Testes dos adapters de mercado: Fundamentus (listas) e brapi (cotação)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dorinvest.adapters.brapi import _parse_history, _parse_quote
from dorinvest.adapters.fundamentus import parse_listing
from dorinvest.domain.rules import parse_br_number

LISTING = (
    "<tr><td><span class=\"tips\" title=\"SUPER TEST CO\">TEST4</span></td>"
    + "</td>".join("".join("<td>%s</td>" % cell for cell in columns) for columns in (
        ["10,00", "5,00", "2,00", "1,500", "4,50%", "0,500", "3,00", "2,50", "1,00", "4,00", "5,00", "30,00%", "20,00%", "10,00%", "1,50", "15,50%", "25,50%", "1.000.000,00", "500.000.000,00", "0,10"],
        ["50,00", "-1,00", "0,50", "N/D", "9,00%", "0,500", "3,00", "2,50", "1,00", "4,00", "5,00", "30,00%", "20,00%", "10,00%", "1,50", "15,50%", "25,50%", "900.000,00", "250.000.000,00", "0,10"],
    ))
    + "</tr>"
)


class FundamentusParsingTest(unittest.TestCase):
    def test_listing(self):
        rows = parse_listing(LISTING)
        self.assertEqual([row["ticker"] for row in rows], ["TEST4"])
        row = rows[0]
        self.assertEqual(row["dy"], 0.045)
        self.assertEqual(row["pl"], 5.0)
        self.assertEqual(row["pvp"], 2.0)
        self.assertEqual(row["patrim"], 500000000.0)
        self.assertEqual(row["margem"], 10.0)

    def test_br_number(self):
        self.assertIsNone(parse_br_number("N/D"))
        self.assertEqual(parse_br_number("1.234,56"), 1234.56)


class BrapiHistoryParsingTest(unittest.TestCase):
    def test_history_orders_and_dedupes(self):
        payload = {"results": [{"historicalDataPrice": [
            {"date": 1790823600, "close": 49.77},
            {"date": 1790737200, "close": 49.12},
            {"date": 1790737200, "close": 49.12},
        ]}]}
        points = _parse_history(payload)
        self.assertEqual([point["date"] for point in points], ["2026-09-30", "2026-10-01"])

    def test_history_requires_two_points(self):
        with self.assertRaises(ValueError):
            _parse_history({"results": [{"historicalDataPrice": [{"date": 1790737200, "close": 49.12}]}]})


class BrapiQuoteParsingTest(unittest.TestCase):
    def test_quote(self):
        quote = _parse_quote("PETR4", {"results": [{"requestedSymbol": "PETR4", "symbol": "PETR4", "data": {"regularMarketPrice": 42.5, "currency": "BRL", "regularMarketTime": "2026-10-28T12:00:00Z"}}]})
        self.assertEqual(quote["price"], 42.5)
        self.assertEqual(quote["currency"], "BRL")

    def test_invalid_price(self):
        with self.assertRaises(ValueError):
            _parse_quote("PETR4", {"results": [{"requestedSymbol": "PETR4", "data": {"regularMarketPrice": 0, "currency": "USD"}}]})


if __name__ == "__main__":
    unittest.main()
