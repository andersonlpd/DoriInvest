import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dorinvest.adapters.benchmarks import BenchmarkService, parse_cdi, parse_yahoo_history


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class StubQuotes:
    def history(self, ticker, days=30):
        return {"ticker": ticker, "points": [
            {"date": "2026-10-01", "close": 100000},
            {"date": "2026-10-15", "close": 110000},
        ]}


class YahooParsingTest(unittest.TestCase):
    def test_parses_and_orders_chart_points(self):
        payload = {"chart": {"result": [{"timestamp": [1790823600, 1790737200], "indicators": {"quote": [{"close": [187198.4, 186340.0]}]}}]}}
        points = parse_yahoo_history(payload)
        self.assertEqual([point["date"] for point in points], ["2026-09-30", "2026-10-01"])
        self.assertEqual(points[1]["value"], 187198.4)


class CdiParsingTest(unittest.TestCase):
    def test_accumulates_daily_rates(self):
        points = parse_cdi([
            {"data": "02/10/2026", "valor": "0.05"},
            {"data": "01/10/2026", "valor": "0.05"},
        ])
        self.assertEqual([p["date"] for p in points], ["2026-10-01", "2026-10-02"])
        self.assertAlmostEqual(points[0]["value"], 100.05)
        self.assertAlmostEqual(points[1]["value"], 100.100025)


class BenchmarkServiceTest(unittest.TestCase):
    def setUp(self):
        self.service = BenchmarkService(StubQuotes())

    def test_rejects_inverted_range(self):
        with self.assertRaises(ValueError):
            self.service.series("2026-10-10", "2026-10-01")

    def test_rejects_more_than_five_years(self):
        with self.assertRaises(ValueError):
            self.service.series("2019-01-01", "2026-10-01")

    def test_series_combines_cdi_and_ibov(self):
        payload = [{"data": "01/10/2026", "valor": "0.05"}, {"data": "15/10/2026", "valor": "0.05"}]
        with patch("dorinvest.adapters.benchmarks.urlopen", return_value=FakeResponse(payload)):
            result = self.service.series("2026-10-01", "2026-10-15")
        self.assertEqual([p["date"] for p in result["series"]["cdi"]], ["2026-10-01", "2026-10-15"])
        self.assertEqual(len(result["series"]["ibov"]), 2)
        self.assertEqual(result["series"]["ibov"][0]["value"], 100000)
        self.assertEqual(result["errors"], {})


if __name__ == "__main__":
    unittest.main()
