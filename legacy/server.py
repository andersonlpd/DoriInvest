#!/usr/bin/env python3
"""Loopback-only DorInvest server, B3 XLSX importer, and quote proxy."""
from __future__ import annotations

import argparse
import calendar
import hashlib
import io
import json
import math
import os
import re
import threading
import time
import unicodedata
import zipfile
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode
from urllib.request import Request, urlopen

from openpyxl import Workbook, load_workbook
from openpyxl.utils.exceptions import InvalidFileException

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD = 20 * 1024 * 1024
MAX_UNCOMPRESSED = 100 * 1024 * 1024
MAX_SHEETS = 40
MAX_ROWS = 50_000
MAX_QUOTE_ASSETS = 100
QUOTE_CACHE_SECONDS = 30 * 60
QUOTE_CACHE = {}
# ponytail: one process-wide lock honors the free tier's single concurrent call; split by API key if multi-account use arrives.
QUOTE_LOCK = threading.Lock()
BRAPI_TEST_TICKERS = {"PETR4", "MGLU3", "VALE3", "ITUB4"}

ALIASES = {
    "ticker": ("codigo de negociacao", "codigo do ativo", "ticker", "papel", "ativo", "produto"),
    "name": ("nome do ativo", "nome", "empresa", "descricao"),
    "quantity": ("quantidade", "qtd", "saldo"),
    "price": ("preco unitario", "valor unitario", "preco atual", "preco de fechamento", "cotacao", "valor da cota", "preco"),
    "average": ("preco medio", "custo medio", "preco de aquisicao", "preco medio de compra"),
    "invested": ("valor aplicado",),
    "total": ("valor da operacao", "valor atualizado", "valor bruto", "valor de mercado", "valor atual", "valor liquido", "valor total", "total", "valor"),
    "date": ("data da movimentacao", "data do movimento", "data pregao", "pagamento", "data"),
    "operation": ("tipo de movimentacao", "tipo de movimento", "tipo de evento", "movimentacao", "movimento", "operacao", "entrada saida"),
    "category": ("tipo de ativo", "classe", "categoria", "produto"),
    "institution": ("instituicao", "corretora"),
}

IGNORED_SHEETS = ("negociacoes",)  # agregados por período virariam posições fantasma


def normalize(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def number(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("R$", "").replace("\u00a0", "").replace(" ", "")
    if not text or text in {"-", "—"}:
        return None
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".") if text.rfind(",") > text.rfind(".") else text.replace(",", "")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        result = float(text.strip("()"))
        return -result if text.startswith("(") and text.endswith(")") else result
    except ValueError:
        return None


def iso_date(value: object) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value or "").strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(text[:10], fmt).date().isoformat()
        except ValueError:
            pass
    return text[:10] if re.match(r"^\d{4}-\d{2}-\d{2}$", text) else None


def classify(text: str) -> str:
    tokens = text.split()
    symbol = tokens[0] if tokens else ""
    if "fiagro" in text:
        return "Fiagros"
    if "fii" in text or "imobili" in text or "imob" in text:
        return "FIIs"
    if "bdr" in text or "depositary" in text or re.fullmatch(r"[a-z0-9]{4}3[4589]", symbol):
        return "BDRs"
    if "etf" in text or "fundo de indice" in text or "indice" in text or "ishares" in text:
        return "ETFs"
    if "tesouro" in text or "renda fixa" in text or any(token in ("cdb", "lci", "lca", "debenture") for token in tokens):
        return "Renda fixa"
    if re.fullmatch(r"[a-z]{4}\d", symbol) or "acao" in text or "acoes" in text or "stock" in text or "equity" in text:
        return "Ações"
    if "crypto" in text or "cripto" in text:
        return "Cripto"
    return "Outros"


def category(value: object, sheet: str) -> str:
    klass = classify(normalize(value))
    return klass if klass != "Outros" else classify(normalize(sheet))


def operation_type(value: object) -> str:
    text = normalize(value)
    if any(word in text for word in ("dividendo", "jcp", "juros", "provento", "rendimento", "reembolso", "amortizacao")):
        return "Provento"
    if any(word in text for word in ("compra", "aplicacao", "entrada")):
        return "Compra"
    if any(word in text for word in ("venda", "resgate", "saida")):
        return "Venda"
    # ponytail: Credito/Debito são os tipos de entrada/saída no XLSX de movimentações da B3.
    if "credito" in text:
        return "Compra"
    if "debito" in text:
        return "Venda"
    return "Evento"


# ponytail: prefix match covers variants like "Preço unitário (W)"; swap to a per-report column map if a real XLSX diverges more.
def header_matches(header: str, alias: str) -> bool:
    return header == alias or (header.startswith(alias) and (len(header) == len(alias) or not header[len(alias)].isalpha()))


def columns_for(row: tuple) -> dict[str, int]:
    headers = [normalize(cell) for cell in row]
    result = {}
    for key, aliases in ALIASES.items():
        for alias in aliases:
            index = next((i for i, header in enumerate(headers) if header_matches(header, alias)), None)
            if index is not None:
                result[key] = index
                break
    return result


def cell(row: tuple, cols: dict[str, int], key: str):
    index = cols.get(key)
    return row[index] if index is not None and index < len(row) else None


def split_ticker(value: str) -> tuple[str, str]:
    text = str(value or "").strip()
    for separator in (" - ", " – "):
        if separator in text:
            symbol, _, name = text.partition(separator)
            symbol = symbol.strip().upper()
            if len(symbol) > 12 or " " in symbol:
                symbol = symbol.split()[0].upper()
            name = name.strip()
            # "CDB - CDB9250MG61 - BANCO X": tipo genérico sem dígito e com código no próximo tramo.
            if not any(char.isdigit() for char in symbol):
                candidate = (name.split(" - ", 1)[0] or "").split()[0].upper() if name else ""
                if len(candidate) <= 12 and any(char.isdigit() for char in candidate):
                    symbol = candidate
            return symbol[:12], name
    # ponytail: sem código separado (ex.: "Tesouro Selic 2027") o nome completo é o identificador.
    return text.upper()[:32], ""


MONTH_WORDS = {
    "janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5, "junho": 6,
    "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12,
}


def report_date(filename: str) -> str | None:
    """Data de fechamento do relatório B3, extraída do nome do arquivo (ex.: mensal-2026-setembro → 2026-09-30)."""
    text = normalize(filename)
    monthly = re.search(r"mensal[^a-z]*([a-z]+)", text)
    if monthly and monthly.group(1) in MONTH_WORDS:
        match = re.search(r"(\d{4})", text)
        if match:
            year = int(match.group(1))
            month = MONTH_WORDS[monthly.group(1)]
            return date(year, month, calendar.monthrange(year, month)[1]).isoformat()
    annual = re.search(r"anual[^a-z]*([a-z]*)", text)
    if annual:
        match = re.search(r"(20\d{2})", text)
        if match:
            return date(int(match.group(1)), 12, 31).isoformat()
    return None


def parse_b3_xlsx(content: bytes, filename: str) -> dict:
    if not content or len(content) > MAX_UPLOAD:
        raise ValueError("O arquivo está vazio ou excede o limite de 20 MB.")
    if not content.startswith(b"PK"):
        raise ValueError("O arquivo não parece ser um XLSX exportado pela B3.")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            files = archive.infolist()
            if len(files) > 2_000 or sum(item.file_size for item in files) > MAX_UNCOMPRESSED:
                raise ValueError("A planilha excede os limites de segurança do importador.")
            if any(item.compress_size and item.file_size / item.compress_size > 500 for item in files):
                raise ValueError("A planilha excede a taxa de compactação permitida.")
        book = load_workbook(io.BytesIO(content), read_only=True, data_only=True, keep_links=False)
    except (zipfile.BadZipFile, InvalidFileException, OSError) as error:
        raise ValueError("Não consegui abrir o XLSX. Baixe novamente o arquivo da Área do Investidor.") from error

    positions, transactions, warnings, snapshot_sheets, sheet_names = [], [], [], [], []
    try:
        if len(book.worksheets) > MAX_SHEETS:
            raise ValueError("A planilha contém abas demais.")
        for sheet in book.worksheets:
            sheet_names.append(sheet.title[:80])
            normalized_sheet_title = normalize(sheet.title)
            sheet.reset_dimensions()  # diagonal B3 reports a "A1" bogus dimension; infer real extent by streaming
            if normalized_sheet_title.startswith(IGNORED_SHEETS):
                warnings.append("Aba {} ignorada: valores agregados por período; use o arquivo de Movimentações ou lance a operação manualmente.".format(sheet.title[:40]))
                continue
            found = None
            for row_index, row in enumerate(sheet.iter_rows(min_row=1, max_row=30, values_only=True), 1):
                cols = columns_for(row)
                if "ticker" in cols and "quantity" in cols and any(key in cols for key in ("price", "total", "operation")):
                    found = (row_index, cols)
                    break
            if not found:
                continue
            header_row, cols = found
            is_movement = "operation" in cols and "date" in cols
            sheet_name = sheet.title[:80]
            normalized_sheet = normalize(sheet_name)
            if not is_movement and any(key in cols for key in ("price", "total")):
                snapshot_sheets.append(normalized_sheet)

            for row_index, row in enumerate(sheet.iter_rows(min_row=header_row + 1, values_only=True), header_row + 1):
                if row_index > MAX_ROWS:
                    warnings.append("Aba {} limitada a {} linhas.".format(sheet_name, MAX_ROWS))
                    break
                ticker, asset_name = split_ticker(str(cell(row, cols, "ticker") or ""))
                qty = number(cell(row, cols, "quantity"))
                kind = operation_type(cell(row, cols, "operation")) if is_movement else None
                if qty is None and kind == "Provento":
                    qty = 0
                if not ticker or qty is None or qty < 0:
                    continue
                name = asset_name or str(cell(row, cols, "name") or ticker).strip()
                asset_class = category(cell(row, cols, "category"), sheet_name)
                price = number(cell(row, cols, "price"))
                total = number(cell(row, cols, "total"))
                average = number(cell(row, cols, "average"))
                invested = number(cell(row, cols, "invested"))
                event_date = iso_date(cell(row, cols, "date"))
                if is_movement and not event_date:
                    warnings.append("{} linha {} sem data; movimentação ignorada.".format(sheet_name, row_index))
                    continue
                institution = str(cell(row, cols, "institution") or "").strip()

                if is_movement:
                    quantity = 0 if kind == "Provento" else abs(qty)
                    unit_price = (total or price or 0) if kind == "Provento" else (price if price is not None else ((total / quantity) if total is not None and quantity else 0))
                    amount = (total if total is not None else unit_price) if kind == "Provento" else (total if total is not None else quantity * unit_price)
                    stable = "|".join(str(v or "") for v in (event_date, ticker, kind, quantity, unit_price, amount, institution))
                    transactions.append({"sourceId": hashlib.sha256(stable.encode()).hexdigest(), "date": event_date, "ticker": ticker, "name": name, "category": asset_class, "type": kind, "quantity": quantity, "price": unit_price, "amount": amount, "label": str(cell(row, cols, "operation") or "")[:64], "source": "B3 XLSX"})
                else:
                    if qty <= 0:
                        continue
                    current_price = price if price is not None else ((total / qty) if total is not None else None)
                    if current_price is None:
                        warnings.append("{}: sem preço/valor atual; linha ignorada.".format(ticker))
                        continue
                    if average is not None:
                        per_unit_cost = average
                    elif invested is not None:
                        per_unit_cost = invested / qty  # "Valor Aplicado" do Tesouro é custo total, não unitário
                    else:
                        per_unit_cost = None
                    product_text = str(cell(row, cols, "category") or "").strip()
                    nice_name = asset_name or (product_text.partition(" - ")[2].strip() if " - " in product_text else product_text)
                    positions.append({"ticker": ticker, "name": nice_name or name, "category": asset_class, "quantity": qty, "averagePrice": per_unit_cost, "currentPrice": current_price, "currentValue": total if total is not None else qty * current_price, "source": "B3"})
    finally:
        book.close()

    # Aggregate repeated tickers from institution-specific rows without inventing missing cost basis.
    grouped = {}
    for position in positions:
        key = (position["ticker"], position["category"])
        item = grouped.setdefault(key, {"ticker": position["ticker"], "name": position["name"], "category": position["category"], "quantity": 0, "currentValue": 0, "cost": 0, "unknownCost": False})
        item["quantity"] += position["quantity"]
        item["currentValue"] += position["currentValue"]
        if position["averagePrice"] is None:
            item["unknownCost"] = True
        else:
            item["cost"] += position["quantity"] * position["averagePrice"]
    snapshot = []
    for item in grouped.values():
        quantity = item["quantity"]
        snapshot.append({"ticker": item["ticker"], "name": item["name"], "category": item["category"], "quantity": quantity, "averagePrice": None if item["unknownCost"] else item["cost"] / quantity, "currentPrice": item["currentValue"] / quantity, "currentValue": item["currentValue"], "source": "B3"})

    if not snapshot and not transactions:
        raise ValueError("Não encontrei tabelas de posição ou movimentação com ativo e quantidade. Use um XLSX da B3 com cabeçalhos legíveis.")
    name = normalize(filename)
    full_snapshot = bool(snapshot) and ("consolidado" in name or any(any(term in sheet for term in ("consolidado", "posicao", "investimento")) for sheet in snapshot_sheets))
    if snapshot and not full_snapshot:
        warnings.append("O relatório parece um recorte por aba/filtro; posições B3 não incluídas serão preservadas.")
    if transactions and not snapshot:
        warnings.append("Este arquivo não contém snapshot de posição; o histórico será adicionado sem recalcular o saldo atual.")
    return {"importId": hashlib.sha256(content).hexdigest(), "source": "B3 XLSX", "referenceDate": max((tx["date"] for tx in transactions if tx["date"]), default=None), "reportDate": report_date(filename), "fullSnapshot": full_snapshot, "positions": snapshot, "transactions": transactions, "sheetNames": sheet_names, "warnings": warnings}


def parse_brapi_quote(ticker: str, payload: dict) -> dict:
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


FUNDAMENTUS_CACHE = {"at": 0.0, "rows": []}
FUNDAMENTUS_CACHE_SECONDS = 6 * 3600

def _parse_br_number(text):
    value = str(text).strip().replace("%", "").strip()
    if not value or value.upper() in {"N/D", "NA", "-"}:
        return None
    value = value.replace(".", "").replace(",", ".")
    try:
        return float(value)
    except ValueError:
        return None

def parse_fundamentus_listing(html):
    "Extrai Papel/Cotação/P-L/P-VP/PSR/DivYield/ROIC/ROE/Liq2m/Patrim Líq da tabela pública do Fundamentus."
    rows = []
    for match in re.finditer(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)(?:</td>\s*|\n)", match.group(1), re.S)
        if len(cells) < 20:
            continue
        name = re.search(r"tips\" title=\"([^\"]+)\"", cells[0])
        ticker = re.search(r">([A-Z0-9]{4,8})<", cells[0])
        span_name = re.search(r"<span[^>]*title=\"([^\"]+)\"", cells[0])
        ticker = ticker.group(1) if ticker else None
        if not ticker or name is None and span_name is None:
            continue
        if re.search(r"Tesouro|<a href=\"detalhes", cells[0]) is None:
            pass
        row_columns = [_parse_br_number(cell) for cell in cells[1:20]]
        quote, pl, pvp, psr, dy_pct, _pa, _pcg, _pebit, _pacl, _evebit, _evebitda, mrg_bru, mrg_ebit, mrg_liq, liqcorr, roic, roe, liq2m, patrim = row_columns
        if not quote or quote <= 0 or not patrim:
            continue
        rows.append({
            "ticker": ticker,
            "name": (span_name or name).group(1)[:40],
            "quote": quote,
            "pl": pl, "pvp": pvp, "psr": psr,
            "dy": None if dy_pct is None else dy_pct / 100,
            "roic": roic, "roe": roe,
            "margins": [mrg_bru, mrg_ebit, mrg_liq],
            "liq2m": liq2m, "patrim": patrim,
        })
    return rows

def rankings_cache():
    "Busca a listagem do Fundamentus (dados públicos) com cache de 6 horas."
    now = time.monotonic()
    if FUNDAMENTUS_CACHE["rows"] and now - FUNDAMENTUS_CACHE["at"] < FUNDAMENTUS_CACHE_SECONDS:
        return FUNDAMENTUS_CACHE["rows"]
    request = Request("https://www.fundamentus.com.br/resultado.php", headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    with urlopen(request, timeout=20) as response:
        html = response.read().decode("latin-1")
    rows = parse_fundamentus_listing(html)
    if len(rows) < 50:
        raise ValueError("A listagem pública do Fundamentus retornou dados incompletos.")
    FUNDAMENTUS_CACHE.update(at=now, rows=rows)
    return rows


def quote_assets(payload: dict) -> dict:
    assets = payload.get("assets") if isinstance(payload, dict) else None
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

    token = os.environ.get("BRAPI_API_KEY", "").strip()
    quotes, errors = [], []
    with QUOTE_LOCK:
        for index, ticker in enumerate(symbols):
            cached = QUOTE_CACHE.get(ticker)
            if cached and time.monotonic() - cached[0] < QUOTE_CACHE_SECONDS:
                quotes.append({**cached[1], "cached": True})
                continue
            if not token and ticker not in BRAPI_TEST_TICKERS:
                errors.append({"ticker": ticker, "code": "api_key_required", "message": "Este ativo exige uma chave gratuita da brapi.dev."})
                continue
            params = urlencode({"symbols": ticker})
            headers = {"Accept": "application/json", "User-Agent": "DorInvest/1.0"}
            if token:
                headers["Authorization"] = "Bearer " + token
            request = Request("https://brapi.dev/api/v2/stocks/quote?" + params, headers=headers)
            try:
                with urlopen(request, timeout=8) as response:
                    quote = parse_brapi_quote(ticker, json.load(response))
                QUOTE_CACHE[ticker] = (time.monotonic(), quote)
                quotes.append({**quote, "cached": False})
            except HTTPError as error:
                code = "no_quote" if error.code == 404 else "rate_limited" if error.code == 429 else "api_key_invalid" if error.code in (401, 403) else "provider_error"
                message = "Sem cotação para {}.".format(ticker) if code == "no_quote" else "Limite gratuito da brapi.dev atingido; tente novamente mais tarde." if code == "rate_limited" else "A brapi.dev rejeitou a chave ou o acesso a este ativo." if code == "api_key_invalid" else "A brapi.dev está indisponível no momento."
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

    return {"provider": "brapi.dev", "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "apiKeyConfigured": bool(token), "quotes": quotes, "errors": errors, "ignored": ignored}


def self_test():
    workbook = Workbook()
    positions = workbook.active
    positions.title = "Posição Ações"
    positions.append(["Código de Negociação", "Nome", "Quantidade", "Preço", "Preço Médio", "Total"])
    positions.append(["PETR4", "Petrobras", 10, 38.0, 32.0, 380.0])
    movements = workbook.create_sheet("Movimentação")
    movements.append(["Data", "Movimentação", "Código de Negociação", "Produto", "Instituição", "Quantidade", "Preço unitário", "Valor da Operação"])
    movements.append([datetime(2026, 10, 20), "Compra", "PETR4", "Ações", "Corretora Exemplo", 2, 37.0, 74.0])
    movements.append([datetime(2026, 10, 21), "Dividendos", "PETR4", "Ações", "Corretora Exemplo", None, 4.5, 4.5])
    movements.append([None, "Venda", "PETR4", "Ações", "Corretora Exemplo", 1, 38.0, 38.0])
    data = io.BytesIO()
    workbook.save(data)
    parsed = parse_b3_xlsx(data.getvalue(), "Relatorio_Consolidado_teste.xlsx")
    assert parsed["fullSnapshot"] and len(parsed["positions"]) == 1
    assert parsed["positions"][0]["averagePrice"] == 32.0
    assert len(parsed["transactions"]) == 2
    assert [tx["type"] for tx in parsed["transactions"]] == ["Compra", "Provento"]
    assert all(tx["category"] == "Ações" for tx in parsed["transactions"])

    # Layout com sufixos de edição do extrato da B3 e variação de cabeçalho.
    workbook2 = Workbook()
    sheet2 = workbook2.active
    sheet2.title = "Posição Consolidada"
    sheet2.append(["Relatório Consolidado — B3"])
    sheet2.append([])
    sheet2.append(["Código de Negociação", "Produto", "Quantidade", "Custo Médio", "Preço Atual", "Valor Atual"])
    sheet2.append(["VALE3", "Ações", 100, 61.2, 62.5, 6250.0])
    sheet3 = workbook2.create_sheet("Movimentações")
    sheet3.append(["Data Pregão", "Tipo de Movimentação (W)", "Código de Negociação", "Produto (W)", "Instituição (W)", "Quantidade (W)", "Preço unitário (W)", "Valor da Operação (W)"])
    sheet3.append([datetime(2026, 10, 20), "Compra (W)", "VALE3", "Ações (W)", "Área do Investidor", 100, 61.2, 6120.0])
    data2 = io.BytesIO()
    workbook2.save(data2)
    parsed2 = parse_b3_xlsx(data2.getvalue(), "Relatorio_Consolidado_202610.xlsx")
    assert parsed2["fullSnapshot"] and len(parsed2["positions"]) == 1
    assert parsed2["positions"][0]["category"] == "Ações" and parsed2["positions"][0]["averagePrice"] == 61.2
    assert parsed2["transactions"][0]["type"] == "Compra" and parsed2["transactions"][0]["price"] == 61.2

    # Layout do XLSX "Movimentação" da Área do Investidor, incluindo dimensão mentirosa ref="A1" (regressão real).
    workbook3 = Workbook()
    sheet3b = workbook3.active
    sheet3b.title = "Movimentação"
    sheet3b.append(["Entrada/Saída", "Data", "Movimentação", "Produto", "Instituição", "Quantidade", "Preço unitário", "Valor da Operação"])
    sheet3b.append(["Credito", "15/10/2026", "Rendimento", "HGLG11 - PÁTRIA LOG - FDO INV IMOB", "AGORA C.T.V.M. S.A.", 28, 1.17, 32.76])
    sheet3b.append(["Credito", "17/10/2026", "Juros Sobre Capital Próprio", "B3SA3 - B3 S.A. - BRASIL, BOLSA, BALCÃO", "AGORA C.T.V.M. S.A.", 10, 0.61, 6.1])
    sheet3b.append(["Credito", "06/10/2026", "Compra", "ABEV3 - AMBEV S.A.", "AGORA C.T.V.M. S.A.", 50, 12.4, 620.0])
    sheet3b.append(["Debito", "27/10/2026", "Venda", "ABEV3 - AMBEV S.A.", "AGORA C.T.V.M. S.A.", 50, 12.9, 645.0])
    sheet3b.append(["Credito", "10/10/2026", "Resgate", "Tesouro Selic 2027", "BMFBOVESPA CTVM SA", 580, 0.03, 17.4])
    sheet3b.append(["Credito", "05/10/2026", "Rendimento", "CDB - CDB9250MG61 - BANCO BRADESCO S/A", "XP S.A.", 1, 3.5, 3.5])
    sheet3b.append(["Credito", "05/10/2026", "Rendimento", "CDB - CDB421FE8B4 - BANCO XP S/A", "XP S.A.", 1, 2.1, 2.1])
    sheet3b.append(["Debito", "03/10/2026", "Fração em Ativos", "ITUB3 - ITAU UNIBANCO HOLDING S.A.", "AGORA C.T.V.M. S.A.", 2, None, None])
    sheet3b.append(["Credito", "05/10/2026", "Bonificação em Ativos", "ITUB3 - ITAU UNIBANCO HOLDING S.A.", "AGORA C.T.V.M. S.A.", 4, None, None])
    data3 = io.BytesIO()
    workbook3.save(data3)
    content3 = data3.getvalue()
    # Simula o gerador da B3 que declara ref="A1" e quebrava o modo read-only.
    content3 = re.sub(rb'<dimension ref="[^"]+"/>', b'<dimension ref="A1"/>', data3.getvalue(), count=1)
    parsed3 = parse_b3_xlsx(content3, "movimentacao-2026-10-28.xlsx")
    assert not parsed3["positions"]
    types3 = [tx["type"] for tx in parsed3["transactions"]]
    assert types3[0] == "Provento" and types3[1] == "Provento" and types3[2] == "Compra" and types3[3] == "Venda"
    hglg = parsed3["transactions"][0]
    assert hglg["ticker"] == "HGLG11" and hglg["name"].startswith("PÁTRIA")
    assert hglg["quantity"] == 0 and hglg["amount"] == 32.76
    assert parsed3["transactions"][2]["ticker"] == "ABEV3"
    assert parsed3["transactions"][4]["ticker"] == "TESOURO SELIC 2027" and parsed3["transactions"][4]["type"] == "Venda"
    assert parsed3["transactions"][5]["ticker"] == "CDB9250MG61" and parsed3["transactions"][6]["ticker"] == "CDB421FE8B4"
    assert parsed3["referenceDate"] == "2026-10-27"
    labels3 = [tx["label"] for tx in parsed3["transactions"]]
    assert "Fração em Ativos" in labels3 and "Bonificação em Ativos" in labels3
    fracao = next(tx for tx in parsed3["transactions"] if tx["label"] == "Fração em Ativos")
    assert fracao["type"] == "Evento" and fracao["quantity"] == 2 and fracao["amount"] == 0

    # Parser da listagem pública do Fundamentus (base das Top listas locais).
    listing = "<tr><td><span class=\"tips\" title=\"SUPER TEST CO\">TEST4</span></td>" + "</td>".join(["".join("<td>%s</td>" % c for c in cols) for cols in (
        ["10,00", "5,00", "2,00", "1,500", "4,50%", "0,500", "3,00", "2,50", "1,00", "4,00", "5,00", "30,00%", "20,00%", "10,00%", "1,50", "15,50%", "25,50%", "1.000.000,00", "500.000.000,00", "0,10"],
        ["50,00", "-1,00", "0,50", "N/D", "9,00%", "0,500", "3,00", "2,50", "1,00", "4,00", "5,00", "30,00%", "20,00%", "10,00%", "1,50", "15,50%", "25,50%", "900.000,00", "250.000.000,00", "0,10"],
    )]) + "</tr>"
    parsed_list = parse_fundamentus_listing(listing)
    assert [row["ticker"] for row in parsed_list] == ["TEST4"]
    row = parsed_list[0]
    assert row["dy"] == 0.045 and row["pl"] == 5.0 and row["pvp"] == 2.0 and row["patrim"] == 500000000.0
    assert _parse_br_number("N/D") is None and _parse_br_number("1.234,56") == 1234.56

    # Abas do relatório consolidado real: posição, Tesouro com custo por "Valor Aplicado",
    # proventos pagos com data "Pagamento", e a aba "Negociações" (agregados) ignorada.
    wb4 = Workbook()
    position_sheet = wb4.active
    position_sheet.title = "Posição - Ações"
    position_sheet.append(["Produto", "Instituição", "Conta", "Código de Negociação", "CNPJ da Empresa", "Código ISIN / Distribuição", "Tipo", "Escriturador", "Quantidade", "Quantidade Disponível", "Quantidade Indisponível", "Motivo", "Preço de Fechamento", "Valor Atualizado"])
    position_sheet.append(["ABEV3 - AMBEV S.A.", "AGORA CORRETORA", "1296541", "ABEV3", "07526557000100", "BRABEVACNOR1", "ON", "BANCO BRADESCO S/A", 366, 366, "-", "-", 15.36, 5621.76])
    treasury_sheet = wb4.create_sheet("Posição - Tesouro Direto")
    treasury_sheet.append(["Produto", "Instituição", "Código ISIN", "Indexador", "Vencimento", "Quantidade", "Quantidade Disponível", "Quantidade Indisponível", "Motivo", "Valor Aplicado", "Valor bruto", "Valor líquido", "Valor Atualizado"])
    treasury_sheet.append(["Tesouro Selic 2027", "AGORA CORRETORA", "BRSTNCLF1RG5", "SELIC", "01/03/2027", 1.93, 1.93, 0, "-", 29966.55, 38591.11, 37014.76, 38591.11])
    payments_sheet = wb4.create_sheet("Proventos Recebidos")
    payments_sheet.append(["Produto", "Pagamento", "Tipo de Evento", "Instituição", "Quantidade", "Preço unitário", "Valor líquido"])
    payments_sheet.append(["BBDC3 - BANCO BRADESCO S/A", "15/09/2026", "Juros Sobre Capital Próprio", "AGORA CORRETORA", 376, 0.32, 97.83])
    trades_sheet = wb4.create_sheet("Negociações")
    trades_sheet.append(["Código de Negociação", "Período (Inicial)", "Período (Final)", "Instituição", "Quantidade (Compra)", "Quantidade (Venda)", "Quantidade (Líquida)", "Preço Médio (Compra)", "Preço Médio (Venda)"])
    trades_sheet.append(["ABEV3", "2026-01-01", "2026-09-30", "AGORA CORRETORA", 500, 100, 400, 14.5, 15.1])
    data4 = io.BytesIO()
    wb4.save(data4)
    parsed4 = parse_b3_xlsx(data4.getvalue(), "relatorio-consolidado-mensal-2026-janeiro.xlsx")
    assert parsed4["fullSnapshot"] and len(parsed4["positions"]) == 2
    by_ticker = {p["ticker"]: p for p in parsed4["positions"]}
    assert by_ticker["ABEV3"]["category"] == "Ações" and by_ticker["ABEV3"]["name"] == "AMBEV S.A."
    assert by_ticker["ABEV3"]["averagePrice"] is None  # consolidado não traz preço médio de ações
    assert by_ticker["TESOURO SELIC 2027"]["category"] == "Renda fixa"
    assert abs(by_ticker["TESOURO SELIC 2027"]["averagePrice"] - 29966.55 / 1.93) < 0.01
    assert abs(by_ticker["TESOURO SELIC 2027"]["currentPrice"] - 38591.11 / 1.93) < 0.01
    payments = [tx for tx in parsed4["transactions"] if tx["type"] == "Provento"]
    assert len(payments) == 1 and payments[0]["ticker"] == "BBDC3" and payments[0]["date"] == "2026-09-15" and payments[0]["amount"] == 97.83
    assert not any(p["ticker"] == "ABEV3" and abs(p["quantity"] - 400) < 1000 for p in parsed4["positions"] if p["category"] != "Ações" or abs(p["quantity"] - 366) > 1)
    assert "ABEV" not in "" and all(t["ticker"] for t in parsed3["transactions"])
    data = io.BytesIO()
    workbook.save(data)
    parsed = parse_b3_xlsx(data.getvalue(), "Relatorio_Consolidado_teste.xlsx")
    assert parsed["fullSnapshot"] and len(parsed["positions"]) == 1
    assert parsed["positions"][0]["averagePrice"] == 32.0
    assert len(parsed["transactions"]) == 2
    assert [tx["type"] for tx in parsed["transactions"]] == ["Compra", "Provento"]
    assert any("sem data; movimentação ignorada" in warning for warning in parsed["warnings"])
    assert parsed4["reportDate"] == "2026-01-31"
    assert parse_b3_xlsx(data4.getvalue(), "relatorio-consolidado-anual-2025.xlsx")["reportDate"] == "2025-12-31"
    assert report_date("movimentacao-2026-10-28.xlsx") is None
    assert parsed["transactions"][0]["sourceId"] == parse_b3_xlsx(data.getvalue(), "Relatorio_Consolidado_teste.xlsx")["transactions"][0]["sourceId"]
    quote = parse_brapi_quote("PETR4", {"results": [{"requestedSymbol": "PETR4", "symbol": "PETR4", "data": {"regularMarketPrice": 42.5, "currency": "BRL", "regularMarketTime": "2026-10-28T12:00:00Z"}}]})
    assert quote["price"] == 42.5 and quote["currency"] == "BRL"
    assert quote_assets({"assets": [{"ticker": "CDB DI", "category": "Renda fixa"}]})["ignored"] == 1


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            return self._json(200, {"status": "ok", "liveB3": False, "xlsxImport": True, "quotes": "brapi.dev", "quoteApiKeyConfigured": bool(os.environ.get("BRAPI_API_KEY", "").strip())})
        if self.path == "/api/rankings":
            try:
                rows = rankings_cache()
            except (HTTPError, URLError, ValueError, TimeoutError) as error:
                message = "Listagem de mercado indisponível agora ({}).".format(type(error).__name__)
                return self._json(503, {"error": message})
            return self._json(200, {"updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": "Fundamentus (dados públicos)", "rows": rows})

        if self.path not in {"/", "/index.html"}:
            return self._json(404, {"error": "Não encontrado."})
        body = (ROOT / "index.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == "/api/log":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > 8 * 1024:
                    return self._json(413, {"saved": False})
                entry = json.loads(self.rfile.read(length))
                record = {key: str(entry.get(key, ""))[:2000] for key in ("context", "message", "stack", "build", "at")}
                path = Path(__file__).with_name("client-errors.log")
                try:
                    if path.exists() and path.stat().st_size > 200_000:
                        path.write_text("\n".join(path.read_text().splitlines()[-50:]) + "\n", encoding="utf-8")
                    with path.open("a", encoding="utf-8") as handle:
                        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                except OSError:
                    pass  # loga no stderr como fallback
                print("[DorInvest client-error] " + record["context"] + ": " + record["message"])
                return self._json(200, {"saved": True})
            except Exception:
                return self._json(400, {"saved": False})
        if self.path == "/api/quotes":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 16 * 1024:
                    raise ValueError("Envie uma lista válida de ativos.")
                return self._json(200, quote_assets(json.loads(self.rfile.read(length))))
            except ValueError as error:
                return self._json(422, {"error": str(error)})
            except Exception:
                return self._json(400, {"error": "Não consegui processar a solicitação de cotações."})
        if self.path != "/api/b3/import":
            return self._json(404, {"error": "Não encontrado."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_UPLOAD:
                raise ValueError("Envie um XLSX válido de até 20 MB.")
            filename = Path(unquote(self.headers.get("X-B3-Filename", "relatorio.xlsx"))).name[:120]
            return self._json(200, parse_b3_xlsx(self.rfile.read(length), filename))
        except ValueError as error:
            return self._json(422, {"error": str(error)})
        except Exception:
            return self._json(400, {"error": "Não consegui ler esse XLSX. Nenhum dado da carteira foi alterado."})

    def log_message(self, fmt, *args):
        print("[DorInvest] " + fmt % args)


def main():
    parser = argparse.ArgumentParser(description="DorInvest local app with B3 XLSX import")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("B3 XLSX importer self-test passed")
        return
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("DorInvest: http://127.0.0.1:{} (B3 live sync disabled)".format(args.port))
    server.serve_forever()


if __name__ == "__main__":
    main()
