import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dorinvest.application.b3_sync import B3SyncService


class B3SyncServiceTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.service = B3SyncService(root / "data", root)
        (root / "data" / "b3-inbox" / "movimentacao.xlsx").write_bytes(b"PK\x03\x04teste")

    def tearDown(self):
        self.folder.cleanup()

    def test_lists_inbox_files(self):
        status = self.service.status()
        self.assertEqual([file["name"] for file in status["files"]], ["movimentacao.xlsx"])
        self.assertFalse(status["running"])

    def test_resolve_rejects_traversal_and_other_extensions(self):
        with self.assertRaises(ValueError):
            self.service.resolve("../segredo.xlsx")
        with self.assertRaises(ValueError):
            self.service.resolve("movimentacao.txt")
        self.assertTrue(self.service.resolve("movimentacao.xlsx").is_file())

    def test_ack_moves_file(self):
        moved = self.service.ack(["movimentacao.xlsx"])
        self.assertEqual(moved, 1)
        self.assertFalse((self.service.inbox / "movimentacao.xlsx").exists())
        self.assertTrue((self.service.processed / "movimentacao.xlsx").exists())

    def test_rejects_invalid_mode(self):
        with self.assertRaises(ValueError):
            self.service.start("apagar")


if __name__ == "__main__":
    unittest.main()
