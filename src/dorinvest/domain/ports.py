"""Portas (ports) da arquitetura hexagonal.

O domínio e a aplicação dependem só destas interfaces. O mundo real entra pelos
adapters (SQLite, brapi.dev, Fundamentus, XLSX, arquivo de log) e pelo driver
HTTP, que recebem implementações dessas interfaces no wiring do main.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class StateRepository(Protocol):
    """Guarda o estado da carteira (posições, operações, favoritos, snapshots)."""

    def load(self) -> dict | None:
        """Estado salco como JSON serializável, ou None quando o banco está vazio."""
    def save(self, state: dict) -> None:
        """Substitui o estado atual (replace-all dentro de uma transação)."""


@runtime_checkable
class QuoteProvider(Protocol):
    """Cotações diárias de um lote de tickers da B3."""

    def quotes(self, symbols: list[str]) -> dict:
        """{"quotes": [...], "errors": [...], "provider": ...} sem cotação inventada."""


@runtime_checkable
class MarketDataSource(Protocol):
    """Listagem de mercado usada pelas Top listas (múltiplos fundamentalistas por ativo)."""

    def rows(self) -> list[dict]:
        """Linhas {ticker, name, quote, pl, pvp, psr, dy, roic, roe, liq2m, patrim}."""


@runtime_checkable
class B3Importer(Protocol):
    """Le o XLSX exportado da Área do Investidor e devolve posições/movimentações."""

    def parse(self, content: bytes, filename: str) -> dict:
        """{"positions": [...], "transactions": [...], "fullSnapshot": bool, "warnings": [...]}."""


@runtime_checkable
class EventLog(Protocol):
    """Destino dos erros reportados pelo navegador (diagnóstico local)."""

    def append(self, record: dict) -> None: ...
