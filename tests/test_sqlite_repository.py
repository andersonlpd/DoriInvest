"""Testes do repositório SQLite."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dorinvest.adapters.sqlite_state import SqliteStateRepository

STATE = {
    "positions": [{"ticker": "PETR4", "quantity": 10, "averagePrice": 32.5, "source": "Manual"}],
    "transactions": [{"id": "x", "date": "2026-10-29", "ticker": "PETR4", "amount": 100}],
    "marketSnapshots": [{"date": "2026-09-30", "value": 1000.0, "source": "B3"}],
    "favorites": ["WEGE3"],
    "watchQuotes": {"WEGE3": {"price": 49.46}},
    "goals": [{"id": "g1", "title": "Primeiro milhão", "type": "patrimonio", "target": 1000000}],
    "alerts": [{"id": "a1", "ticker": "PETR4", "direction": "acima", "price": 40}],
    "b3SyncMeta": None,
    "quoteSyncMeta": None,
}


class SqliteRepositoryTest(unittest.TestCase):
    def test_empty_load_returns_none(self):
        with tempfile.TemporaryDirectory() as folder:
            repository = SqliteStateRepository(Path(folder) / "dorinvest.db")
            self.assertIsNone(repository.load())

    def test_save_and_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            repository = SqliteStateRepository(Path(folder) / "dorinvest.db")
            repository.save(STATE)
            loaded = repository.load()
            self.assertEqual(loaded["positions"], STATE["positions"])
            self.assertEqual(loaded["transactions"], STATE["transactions"])
            self.assertEqual(loaded["marketSnapshots"], STATE["marketSnapshots"])
            self.assertEqual(loaded["favorites"], ["WEGE3"])
            self.assertEqual(loaded["watchQuotes"], {"WEGE3": {"price": 49.46}})
            self.assertEqual(loaded["goals"], STATE["goals"])
            self.assertEqual(loaded["alerts"], STATE["alerts"])

    def test_save_replaces_previous_state(self):
        with tempfile.TemporaryDirectory() as folder:
            repository = SqliteStateRepository(Path(folder) / "dorinvest.db")
            repository.save(STATE)
            repository.save({"positions": [{"ticker": "VALE3", "quantity": 1}], "transactions": [], "marketSnapshots": [], "favorites": [], "watchQuotes": {}, "goals": [], "alerts": [], "b3SyncMeta": None, "quoteSyncMeta": None})
            loaded = repository.load()
            self.assertEqual([p["ticker"] for p in loaded["positions"]], ["VALE3"])
            self.assertEqual(loaded["transactions"], [])


if __name__ == "__main__":
    unittest.main()
