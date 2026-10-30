"""Wiring da aplicação: monta os adapters reais e sobe o servidor local.

Uso: python3 run.py [--port 8000] [--db data/dorinvest.db] [--self-test]
Sem flag, http://127.0.0.1:port serve o frontend e as rotas /api/*.
"""
from __future__ import annotations

import argparse
from http.server import ThreadingHTTPServer
from pathlib import Path

from .adapters.b3_xlsx import B3XlsxImporter
from .adapters.benchmarks import BenchmarkService as BenchmarkSource
from .adapters.brapi import BrapiQuoteProvider
from .adapters.file_log import FileEventLog
from .adapters.fundamentus import FundamentusMarketSource
from .adapters.sectors import B3SectorMap
from .adapters.sqlite_state import SqliteStateRepository
from .application.services import BenchmarkService, ClientLogService, ImportService, MarketService, PortfolioService, QuoteService
from .infrastructure.http_api import build_handler

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT / "frontend"
DATA_DIR = ROOT / "data"


def wire(db_path: Path) -> dict:
    "Composição do hexágono: adapters concretos embalados em services da aplicação."
    repository = SqliteStateRepository(db_path)
    provider = BrapiQuoteProvider()
    return {
        "portfolio": PortfolioService(repository),
        "quotes": QuoteService(provider),
        "market": MarketService(FundamentusMarketSource(), B3SectorMap()),
        "benchmarks": BenchmarkService(BenchmarkSource(provider)),
        "import": ImportService(B3XlsxImporter()),
        "log": ClientLogService(FileEventLog(DATA_DIR / "client-errors.log")),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="DorInvest local: B3 XLSX, cotações brapi e listas de mercado em SQLite")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", type=Path, default=DATA_DIR / "dorinvest.db")
    args = parser.parse_args()

    db_path = args.db
    db_path.parent.mkdir(parents=True, exist_ok=True)
    services = wire(db_path)
    handler = build_handler(services, FRONTEND_DIR, DATA_DIR)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print("DorInvest: http://127.0.0.1:{} (banco: {})".format(args.port, db_path))
    server.serve_forever()
