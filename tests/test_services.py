import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dorinvest.application.services import PortfolioService


class MemoryRepository:
    def __init__(self):
        self.state = None

    def load(self):
        return self.state

    def save(self, state):
        self.state = state


class PortfolioServiceTest(unittest.TestCase):
    def setUp(self):
        self.repository = MemoryRepository()
        self.service = PortfolioService(self.repository)

    def _body(self, positions, transactions=None):
        return json.dumps({"positions": positions, "transactions": transactions or []}).encode()

    def test_accepts_treasury_names_with_plus(self):
        body = self._body([{"ticker": "TESOURO EDUCA+ 2043", "quantity": 1}])
        self.assertTrue(self.service.save_state(body))

    def test_rejects_position_without_quantity(self):
        body = self._body([{"ticker": "PETR4", "quantity": 0}])
        with self.assertRaises(ValueError):
            self.service.save_state(body)

    def test_rejects_invalid_transaction_date(self):
        body = self._body([{"ticker": "PETR4", "quantity": 1}], [{"date": "ontem"}])
        with self.assertRaises(ValueError):
            self.service.save_state(body)

    def test_accepts_goals_and_alerts(self):
        body = json.dumps({"positions": [], "goals": [{"id": "g", "title": "Milionário", "type": "patrimonio", "target": 1000000}], "alerts": [{"id": "a", "ticker": "PETR4", "direction": "acima", "price": 40}]}).encode()
        self.assertTrue(self.service.save_state(body))

    def test_rejects_invalid_goal(self):
        body = json.dumps({"positions": [], "goals": [{"id": "g", "title": "X", "type": "patrimonio", "target": 0}]}).encode()
        with self.assertRaises(ValueError):
            self.service.save_state(body)

    def test_rejects_invalid_alert(self):
        body = json.dumps({"positions": [], "alerts": [{"id": "a", "ticker": "PETR4", "direction": "quando der", "price": 40}]}).encode()
        with self.assertRaises(ValueError):
            self.service.save_state(body)

    def test_rejects_unknown_keys(self):
        body = json.dumps({"positions": [], "backdoor": True}).encode()
        with self.assertRaises(ValueError):
            self.service.save_state(body)


if __name__ == "__main__":
    unittest.main()
