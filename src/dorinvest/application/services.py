"""Serviços de aplicação: casos de uso que ligam a API HTTP aos adapters.

Aqui ficam as regras de orquestração (validar payloads, montar o estado,
chamar os ports). Sem bibliotecas de framework; o driver HTTP continua sendo
o http.server da biblioteca padrão.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from ..adapters.brapi import BrapiQuoteProvider
from ..domain.ports import B3Importer, EventLog, MarketDataSource, StateRepository

MAX_STATE_BODY = 20 * 1024 * 1024
MAX_QUOTE_ASSETS = 100
STATE_KEYS = ("positions", "transactions", "marketSnapshots", "favorites", "watchQuotes", "goals", "alerts", "b3SyncMeta", "quoteSyncMeta")


class PortfolioService:
    "Estado da carteira: o navegador salva o documento inteiro, o banco substitui tudo."

    def __init__(self, repository: StateRepository):
        self.repository = repository

    def get_state(self) -> dict:
        state = self.repository.load()
        if state is None:
            return {key: [] if key != "watchQuotes" else {} for key in STATE_KEYS if key not in ("b3SyncMeta", "quoteSyncMeta")} | {"b3SyncMeta": None, "quoteSyncMeta": None}
        return state

    def save_state(self, raw: bytes) -> bool:
        if len(raw) < 2 or len(raw) > MAX_STATE_BODY:
            raise ValueError("Envie um estado válido de até 20 MB.")
        state = json.loads(raw)
        if not isinstance(state, dict):
            raise ValueError("O estado enviado não é um objeto JSON.")
        unknown = [key for key in state if key not in STATE_KEYS]
        if unknown:
            raise ValueError("O estado contém chaves inesperadas: {}.".format(", ".join(sorted(unknown)[:4])))
        positions = state.get("positions") or []
        transactions = state.get("transactions") or []
        for position in positions:
            ticker = str(position.get("ticker", "")).strip().upper()
            cantidad = position.get("quantity")
            if not re.fullmatch(r"[^\x00-\x1f]{2,64}", ticker) or not isinstance(cantidad, (int, float)) or cantidad <= 0:
                raise ValueError("Posição inválida no estado: {}.".format(ticker or "<sem ticker>"))
        for transaction in transactions:
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(transaction.get("date", ""))):
                raise ValueError("Movimentação sem data válida.")
        for goal in state.get("goals") or []:
            target = goal.get("target") if isinstance(goal, dict) else None
            if not isinstance(target, (int, float)) or target <= 0 or goal.get("type") not in ("patrimonio", "renda"):
                raise ValueError("Meta inválida no estado.")
        for alert in state.get("alerts") or []:
            ticker = str(alert.get("ticker", "")).strip().upper() if isinstance(alert, dict) else ""
            price = alert.get("price") if isinstance(alert, dict) else None
            direction = alert.get("direction") if isinstance(alert, dict) else None
            if not re.fullmatch(r"[A-Z0-9]{4,8}", ticker) or not isinstance(price, (int, float)) or price <= 0 or direction not in ("acima", "abaixo"):
                raise ValueError("Alerta inválido no estado.")
        self.repository.save(state)
        return True


class QuoteService:
    "Valida a lista de ativos e repassa ao provider (brapi.dev)."

    def __init__(self, provider: BrapiQuoteProvider):
        self.provider = provider

    def refresh(self, payload: dict | None, raw_size: int) -> dict:
        if raw_size < 1 or raw_size > 16 * 1024:
            raise ValueError("Envie uma lista válida de ativos.")
        payload = payload if isinstance(payload, dict) else {}
        assets = payload.get("assets")
        if not isinstance(assets, list) or not assets or len(assets) > MAX_QUOTE_ASSETS:
            raise ValueError("Envie uma lista de até {} ativos.".format(MAX_QUOTE_ASSETS))
        symbols, ignored = [], 0
        for asset in assets:
            if not isinstance(asset, dict):
                raise ValueError("Ativo inválido na solicitação de cotações.")
            ticker = str(asset.get("ticker", "")).strip().upper()
            if str(asset.get("category", "")).strip().lower() == "renda fixa" or not re.fullmatch(r"[A-Z0-9]{4,8}", ticker) or not any(char.isdigit() for char in ticker):
                ignored += 1
                continue
            if ticker not in symbols:
                symbols.append(ticker)
        result = self.provider.quotes(symbols)
        result["ignored"] = ignored
        return result

    def history(self, ticker: str, days: int = 30) -> dict:
        ticker = str(ticker or "").strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{4,8}", ticker):
            raise ValueError("Informe um ticker válido para o histórico.")
        return self.provider.history(ticker, days)


class MarketService:
    "Materia-prima das Top listas: linhas de mercado com data de atualização."

    def __init__(self, source: MarketDataSource, sectors=None):
        self.source = source
        self.sectors = sectors

    def ranking_rows(self) -> dict:
        rows = self.source.rows()
        if self.sectors is not None:
            self.sectors.enrich(rows)
        return {"updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": "Fundamentus (dados públicos)", "sectors": "B3 (setor/subsetor/segmento)", "rows": rows}


class BenchmarkService:
    "Séries de Ibovespa e CDI para as linhas comparativas do gráfico."

    def __init__(self, benchmarks):
        self.benchmarks = benchmarks

    def series(self, start: str, end: str) -> dict:
        return self.benchmarks.series(start, end)


class ImportService:
    "Recebe o XLSX do navegador e devolve o lote estruturado (posições + movimentações)."

    def __init__(self, importer: B3Importer):
        self.importer = importer

    def parse(self, content: bytes, filename: str) -> dict:
        return self.importer.parse(content, filename)


class ClientLogService:
    "Erros do navegador; batch pequeno, corpo limitado, nada de inventar detalhes."

    def __init__(self, logger: EventLog):
        self.logger = logger

    def record(self, raw: bytes) -> bool:
        if len(raw) > 8 * 1024:
            raise ValueError("Registro de erro grande demais.")
        entry = json.loads(raw)
        if not isinstance(entry, dict):
            raise ValueError("Registro inválido.")
        record = {key: str(entry.get(key, ""))[:2000] for key in ("context", "message", "stack", "build", "at")}
        self.logger.append(record)
        return True
