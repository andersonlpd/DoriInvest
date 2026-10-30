import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dorinvest.adapters.sectors import B3SectorMap


class SectorMapTest(unittest.TestCase):
    def setUp(self):
        self.map = B3SectorMap()

    def test_known_tickers_have_sector(self):
        self.assertEqual(self.map.for_ticker("PETR4")["setor"], "Petróleo, Gás e Biocombustíveis")
        self.assertEqual(self.map.for_ticker("vale3")["segmento"], "Minerais Metálicos")

    def test_unknown_ticker_is_ignored(self):
        rows = [{"ticker": "ZZZZ9"}]
        self.map.enrich(rows)
        self.assertIsNone(rows[0]["setor"])

    def test_enrich_fills_all_three_levels(self):
        rows = [{"ticker": "BBAS3"}]
        self.map.enrich(rows)
        self.assertEqual(rows[0]["subsetor"], "Intermediários Financeiros")
        self.assertEqual(rows[0]["segmento"], "Bancos")


if __name__ == "__main__":
    unittest.main()
