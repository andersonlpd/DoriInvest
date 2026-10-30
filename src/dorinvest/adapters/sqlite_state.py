"""Adapter SQLite para o repositório de estado (banco local, arquivo único).

Schema único e simples: posições, operações, snapshots, favoritos, meta.
O save é replace-all dentro de uma transação (a carteira é pequena e o fluxo
da interface salva o estado inteiro em cada persistência).
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    ticker TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    date TEXT,
    ticker TEXT,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
    date TEXT PRIMARY KEY,
    value REAL,
    source TEXT,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


class SqliteStateRepository:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _init_schema(self):
        with self._connect() as connection:
            connection.executescript(SCHEMA)

    def load(self) -> dict | None:
        with self._connect() as connection:
            rows = connection.execute("SELECT key, value FROM meta").fetchall()
            positions = [json.loads(row[0]) for row in connection.execute("SELECT payload FROM positions ORDER BY ticker")]
            transactions = [json.loads(row[0]) for row in connection.execute("SELECT payload FROM transactions ORDER BY date, id")]
            snapshots = [{"date": row[0], "value": row[1], "source": row[2]} for row in connection.execute("SELECT date, value, source FROM snapshots ORDER BY date")]
            counts = connection.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
        meta = {key: json.loads(value) for key, value in rows}
        if counts == 0 and not transactions and not snapshots and not meta:
            return None
        return {
            "positions": positions,
            "transactions": transactions,
            "marketSnapshots": snapshots,
            "favorites": meta.get("favorites", []),
            "watchQuotes": meta.get("watchQuotes", {}),
            "goals": meta.get("goals", []),
            "alerts": meta.get("alerts", []),
            "b3SyncMeta": meta.get("b3SyncMeta"),
            "quoteSyncMeta": meta.get("quoteSyncMeta"),
        }

    def save(self, state: dict) -> None:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        positions = state.get("positions") or []
        transactions = state.get("transactions") or []
        snapshots = state.get("marketSnapshots") or []
        favorites = state.get("favorites") or []
        watch_quotes = state.get("watchQuotes") or {}
        with self._connect() as connection:
            connection.execute("DELETE FROM positions")
            connection.execute("DELETE FROM transactions")
            connection.execute("DELETE FROM snapshots")
            connection.execute("DELETE FROM meta")
            connection.executemany(
                "INSERT INTO positions (ticker, payload, updated_at) VALUES (?, ?, ?)",
                [(row.get("ticker"), json.dumps(row, ensure_ascii=False), now) for row in positions],
            )
            connection.executemany(
                "INSERT INTO transactions (id, date, ticker, payload) VALUES (?, ?, ?, ?)",
                [
                    (row.get("sourceId") or row.get("id"), row.get("date"), row.get("ticker"), json.dumps(row, ensure_ascii=False))
                    for row in transactions
                ],
            )
            connection.executemany(
                "INSERT INTO snapshots (date, value, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at",
                [(row.get("date"), row.get("value"), row.get("source"), now) for row in snapshots if row.get("date")],
            )
            connection.executemany(
                "INSERT INTO meta (key, value) VALUES (?, ?)",
                [
                    ("favorites", json.dumps(favorites, ensure_ascii=False)),
                    ("watchQuotes", json.dumps(watch_quotes, ensure_ascii=False)),
                    ("goals", json.dumps(state.get("goals") or [], ensure_ascii=False)),
                    ("alerts", json.dumps(state.get("alerts") or [], ensure_ascii=False)),
                    ("b3SyncMeta", json.dumps(state.get("b3SyncMeta"), ensure_ascii=False)),
                    ("quoteSyncMeta", json.dumps(state.get("quoteSyncMeta"), ensure_ascii=False)),
                ],
            )
