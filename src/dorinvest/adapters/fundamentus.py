"""Adapter da listagem pública do Fundamentus, fonte das Top listas de mercado.

Uma página só com centenas de ativos; cache de 6 horas para não martelar o
site a cada carregamento de página. Parse em regex estável com a tabela real
do resultado.php.
"""
from __future__ import annotations

import re
import threading
import time
from urllib.request import Request, urlopen

from ..domain import rules

FUNDAMENTUS_URL = "https://www.fundamentus.com.br/resultado.php"
_CACHE = {"at": 0.0, "rows": []}
_CACHE_SECONDS = 6 * 3600
_LOCK = threading.Lock()


def parse_listing(html: str) -> list[dict]:
    rows = []
    for match in re.finditer(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)(?:</td>\s*|\n)", match.group(1), re.S)
        if len(cells) < 20:
            continue
        name = re.search(r"tips\" title=\"([^\"]+)\"", cells[0])
        ticker = re.search(r">([A-Z0-9]{4,8})<", cells[0])
        span_name = re.search(r"<span[^>]*title=\"([^\"]+)\"", cells[0])
        ticker = ticker.group(1) if ticker else None
        if not ticker or (name is None and span_name is None):
            continue
        values = [rules.parse_br_number(cell) for cell in cells[1:20]]
        quote, pl, pvp, psr, dy_pct, _pa, _pcg, _pebit, _pacl, _evebit, _evebitda, _mrg_bru, _mrg_ebit, margem, _liqcorr, roic, roe, liq2m, patrim = values
        if not quote or quote <= 0 or not patrim:
            continue
        rows.append({
            "ticker": ticker,
            "name": (span_name or name).group(1)[:40],
            "quote": quote,
            "pl": pl, "pvp": pvp, "psr": psr,
            "dy": None if dy_pct is None else dy_pct / 100,
            "roic": roic, "roe": roe, "margem": margem,
            "liq2m": liq2m, "patrim": patrim,
        })
    return rows


class FundamentusMarketSource:
    def rows(self) -> list[dict]:
        now = time.monotonic()
        if _CACHE["rows"] and now - _CACHE["at"] < _CACHE_SECONDS:
            return _CACHE["rows"]
        with _LOCK:
            if _CACHE["rows"] and now - _CACHE["at"] < _CACHE_SECONDS:
                return _CACHE["rows"]
            request = Request(FUNDAMENTUS_URL, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
            with urlopen(request, timeout=20) as response:
                html = response.read().decode("latin-1")
            rows = parse_listing(html)
            if len(rows) < 50:
                raise ValueError("A listagem pública do Fundamentus retornou dados incompletos.")
            _CACHE.update(at=now, rows=rows)
            return rows
