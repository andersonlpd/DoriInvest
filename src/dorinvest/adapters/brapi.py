"""Adapter de cotações diárias via brapi.dev (plano gratuito).

Chave lida do ambiente (BRAPI_API_KEY), cache de 30 minutos e um lock único
para o processo: a conta gratuita aceita uma chamada por vez. Nada de cotação
inventada; erro vira registro na lista de erros.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

BRAPI_TEST_TICKERS = {"PETR4", "MGLU3", "VALE3", "ITUB4"}
QUOTE_CACHE_SECONDS = 30 * 60
HISTORY_CACHE_SECONDS = 30 * 60
# ponytail: um lock para o processo respeita a chamada única concorrente do tier gratuito;
# dividir por chave de API se surgir uso multi-conta.
QUOTE_LOCK = threading.Lock()


def _parse_quote(ticker: str, payload: dict) -> dict:
    results = payload.get("results", []) if isinstance(payload, dict) else []
    result = next((item for item in results if isinstance(item, dict) and item.get("requestedSymbol", item.get("symbol")) == ticker), None) if isinstance(results, list) else None
    data = result.get("data", {}) if result else {}
    if not isinstance(data, dict):
        data = {}
    price = data.get("regularMarketPrice")
    if not isinstance(price, (int, float)) or isinstance(price, bool) or not math.isfinite(price) or price <= 0:
        raise ValueError("Cotação indisponível para {}.".format(ticker))
    currency = str(data.get("currency", "")).upper()
    if currency != "BRL":
        raise ValueError("{} não retornou cotação em BRL.".format(ticker))
    return {"ticker": ticker, "symbol": result.get("symbol", ticker), "price": float(price), "currency": currency, "quoteTime": data.get("regularMarketTime"), "source": "brapi.dev"}


def _parse_history(payload: dict) -> list[dict]:
    results = payload.get("results", []) if isinstance(payload, dict) else []
    result = next((item for item in results if isinstance(item, dict)), None) if isinstance(results, list) else None
    data = result.get("data", {}) if result else {}
    raw = data.get("historicalDataPrice") if isinstance(data, dict) else None
    if raw is None and isinstance(result, dict):
        raw = result.get("historicalDataPrice")
    points: list[dict] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        timestamp = item.get("date")
        close = item.get("close") if item.get("close") is not None else item.get("adjustedClose")
        if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool):
            continue
        if not isinstance(close, (int, float)) or isinstance(close, bool) or not math.isfinite(close) or close <= 0:
            continue
        day = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
        points.append({"date": day, "close": float(close)})
    deduped: dict[str, dict] = {}
    for point in points:
        deduped[point["date"]] = point
    ordered = [deduped[key] for key in sorted(deduped)]
    if len(ordered) < 2:
        raise ValueError("Histórico de preços insuficiente para este ativo.")
    return ordered


class BrapiQuoteProvider:
    def __init__(self, token: str | None = None):
        self.token = (token or os.environ.get("BRAPI_API_KEY", "")).strip()
        self._cache: dict[str, tuple[float, dict]] = {}
        self._history_cache: dict[str, tuple[float, dict]] = {}

    def api_key_configured(self) -> bool:
        return bool(self.token)

    def quotes(self, symbols: list[str]) -> dict:
        quotes, errors = [], []
        with QUOTE_LOCK:
            for index, ticker in enumerate(symbols):
                cached = self._cache.get(ticker)
                if cached and time.monotonic() - cached[0] < QUOTE_CACHE_SECONDS:
                    quotes.append({**cached[1], "cached": True})
                    continue
                if not self.token and ticker not in BRAPI_TEST_TICKERS:
                    errors.append({"ticker": ticker, "code": "api_key_required", "message": "Este ativo exige uma chave gratuita da brapi.dev."})
                    continue
                params = urlencode({"symbols": ticker})
                headers = {"Accept": "application/json", "User-Agent": "DorInvest/1.0"}
                if self.token:
                    headers["Authorization"] = "Bearer " + self.token
                request = Request("https://brapi.dev/api/v2/stocks/quote?" + params, headers=headers)
                try:
                    with urlopen(request, timeout=8) as response:
                        quote = _parse_quote(ticker, json.load(response))
                    self._cache[ticker] = (time.monotonic(), quote)
                    quotes.append({**quote, "cached": False})
                except HTTPError as error:
                    code = "no_quote" if error.code == 404 else "rate_limited" if error.code == 429 else "api_key_invalid" if error.code in (401, 403) else "provider_error"
                    if code == "no_quote":
                        message = "Sem cotação para {}.".format(ticker)
                    elif code == "rate_limited":
                        message = "Limite gratuito da brapi.dev atingido; tente novamente mais tarde."
                    elif code == "api_key_invalid":
                        message = "A brapi.dev rejeitou a chave ou o acesso a este ativo."
                    else:
                        message = "A brapi.dev está indisponível no momento."
                    errors.append({"ticker": ticker, "code": code, "message": message})
                    if error.code in (401, 403, 429) or error.code >= 500:
                        errors.extend({"ticker": symbol, "code": code, "message": message} for symbol in symbols[index + 1:])
                        break
                except (URLError, TimeoutError, json.JSONDecodeError):
                    errors.append({"ticker": ticker, "code": "provider_error", "message": "Falha ao obter uma cotação válida da brapi.dev."})
                    errors.extend({"ticker": symbol, "code": "provider_error", "message": "Cotação não consultada porque a brapi.dev está indisponível."} for symbol in symbols[index + 1:])
                    break
                except ValueError:
                    errors.append({"ticker": ticker, "code": "provider_error", "message": "Falha ao obter uma cotação válida da brapi.dev."})
        return {"provider": "brapi.dev", "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "apiKeyConfigured": bool(self.token), "quotes": quotes, "errors": errors}

    def history(self, ticker: str, days: int = 30) -> dict:
        days = max(5, min(365, int(days)))
        cache_key = "{}:{}".format(ticker, days)
        cached = self._history_cache.get(cache_key)
        now = time.monotonic()
        if cached and now - cached[0] < HISTORY_CACHE_SECONDS:
            return {**cached[1], "cached": True}
        if days <= 31:
            window = "1mo"
        elif days <= 93:
            window = "3mo"
        elif days <= 186:
            window = "6mo"
        elif days <= 366:
            window = "1y"
        elif days <= 732:
            window = "2y"
        else:
            window = "5y"
        params = urlencode({"range": window, "interval": "1d"})
        headers = {"Accept": "application/json", "User-Agent": "DoriInvest/1.0"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = Request("https://brapi.dev/api/quote/{}?{}".format(quote(ticker, safe=""), params), headers=headers)
        with QUOTE_LOCK:
            with urlopen(request, timeout=12) as response:
                points = _parse_history(json.load(response))
        points = points[-days:]
        payload = {
            "ticker": ticker,
            "source": "brapi.dev",
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "points": points,
        }
        self._history_cache[cache_key] = (now, payload)
        return {**payload, "cached": False}
