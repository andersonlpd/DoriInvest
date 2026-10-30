"""Benchmarks do gráfico de patrimônio: Ibovespa pela brapi e CDI pelo Banco Central.

As duas séries são públicas. O CDI diário vem do SGS 12 e é acumulado em um
índice base 100; o Ibovespa usa o histórico diário da brapi, o mesmo adapter das
cotações. Cada fonte falha de forma independente para o gráfico não sumir por
causa de uma delas.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CDI_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados"
YAHOO_IBOV = "https://query2.finance.yahoo.com/v8/finance/chart/%5EBVSP"
YAHOO_HEADERS = {"Accept": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
CACHE_SECONDS = 6 * 3600
_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}
_LOCK = threading.Lock()


def parse_cdi(payload: object) -> list[dict]:
    rows: list[tuple[str, float]] = []
    if isinstance(payload, list):
        for item in payload:
            if not isinstance(item, dict):
                continue
            try:
                day = datetime.strptime(str(item.get("data", "")), "%d/%m/%Y").date().isoformat()
                rate = float(item.get("valor"))
            except (TypeError, ValueError):
                continue
            rows.append((day, rate))
    rows.sort()
    level, points = 100.0, []
    for day, rate in rows:
        level *= 1 + rate / 100
        points.append({"date": day, "value": round(level, 6)})
    return points


def parse_yahoo_history(payload: object) -> list[dict]:
    try:
        result = payload["chart"]["result"][0]  # type: ignore[index]
        timestamps = result["timestamp"]
        closes = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError):
        return []
    by_day: dict[str, float] = {}
    for timestamp, close in zip(timestamps, closes):
        if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool):
            continue
        if not isinstance(close, (int, float)) or isinstance(close, bool) or close <= 0:
            continue
        day = datetime.fromtimestamp(timestamp, tz=timezone.utc).date().isoformat()
        by_day[day] = round(float(close), 2)
    return [{"date": day, "value": by_day[day]} for day in sorted(by_day)]


class BenchmarkService:
    def __init__(self, quotes):
        self.quotes = quotes

    def series(self, start: str, end: str) -> dict:
        start, end = str(start)[:10], str(end)[:10]
        start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)
        if start_date > end_date:
            raise ValueError("A data inicial do comparativo vem depois da final.")
        if (end_date - start_date).days > 365 * 5:
            raise ValueError("O comparativo cobre no máximo cinco anos.")
        key = (start, end)
        cached = _CACHE.get(key)
        now = time.monotonic()
        if cached and now - cached[0] < CACHE_SECONDS:
            return {**cached[1], "cached": True}
        result = {"start": start, "end": end, "series": {}, "errors": {}}
        with _LOCK:
            try:
                fetch_start = (start_date - timedelta(days=7)).strftime("%d/%m/%Y")
                query = urlencode({"formato": "json", "dataInicial": fetch_start, "dataFinal": end_date.strftime("%d/%m/%Y")})
                request = Request(CDI_URL + "?" + query, headers={"Accept": "application/json", "User-Agent": "DoriInvest/1.0"})
                with urlopen(request, timeout=15) as response:
                    points = parse_cdi(json.load(response))
                if points:
                    result["series"]["cdi"] = points
                else:
                    result["errors"]["cdi"] = "Banco Central sem dados para o período."
            except Exception:
                result["errors"]["cdi"] = "CDI indisponível agora."
            days = (end_date - start_date).days + 1
            window = "1mo" if days <= 31 else "3mo" if days <= 93 else "6mo" if days <= 186 else "1y" if days <= 366 else "2y" if days <= 732 else "5y" if days <= 1825 else "10y"
            points = []
            try:
                request = Request(YAHOO_IBOV + "?" + urlencode({"range": window, "interval": "1d"}), headers=YAHOO_HEADERS)
                with urlopen(request, timeout=15) as response:
                    points = [point for point in parse_yahoo_history(json.load(response)) if start <= point["date"] <= end]
            except Exception:
                points = []
            if not points:
                try:
                    history = self.quotes.history("^BVSP", min(days, 93))
                    points = [{"date": point["date"], "value": point["close"]} for point in history.get("points", []) if start <= point["date"] <= end and isinstance(point.get("close"), (int, float))]
                except Exception:
                    points = []
            if points:
                result["series"]["ibov"] = points
            else:
                result["errors"]["ibov"] = "Ibovespa indisponível agora."
        _CACHE[key] = (now, result)
        return result
