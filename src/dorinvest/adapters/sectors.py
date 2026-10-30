"""Classificação setorial oficial da B3 (setor, subsetor e segmento) por ticker.

O snapshot `data/setores_b3.json` foi levantado das páginas de setor do Status
Invest (que usa a classificação setorial da B3) e enquadra as ações de capital
aberto. O arquivo é estático: a classificação muda raramente (IPO novo, troca de
segmento), então não há scraping em tempo de execução. Para atualizar, regenere
o snapshot com o script descrito em docs/ARQUITETURA.md.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

DATA = Path(__file__).with_name("data") / "setores_b3.json"
_COMMA = re.compile(r"(\w)\.\s+")


def _tidy(text: object) -> str | None:
    if text is None:
        return None
    value = _COMMA.sub(r"\1, ", str(text)).strip()
    return value or None


class B3SectorMap:
    "Leitura preguiçosa do snapshot; enriquece as linhas de mercado com o setor."

    def __init__(self, path: Path | None = None):
        self._path = Path(path) if path else DATA
        self._map: dict[str, dict] = {}
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(raw, dict):
            return
        for ticker, info in raw.items():
            if not isinstance(info, dict):
                continue
            self._map[str(ticker).strip().upper()] = {key: _tidy(info.get(key)) for key in ("setor", "subsetor", "segmento")}

    def for_ticker(self, ticker: str) -> dict | None:
        self._load()
        return self._map.get(str(ticker or "").strip().upper())

    def enrich(self, rows: list[dict]) -> list[dict]:
        self._load()
        for row in rows:
            info = self._map.get(str(row.get("ticker", "")).strip().upper()) or {}
            row["setor"] = info.get("setor")
            row["subsetor"] = info.get("subsetor")
            row["segmento"] = info.get("segmento")
        return rows
