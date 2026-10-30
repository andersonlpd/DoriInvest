"""Regras puras de classificação e leitura dos dados da B3.

Nada aqui toca IO: as funções recebem texto e devolvem valores. Os adapters
(como o importador de XLSX e o proxy de cotações) chamam estas funções para
interpretar as linhas das planilhas da Área do Investidor.
"""
from __future__ import annotations

import calendar
import re
import unicodedata
from datetime import date, datetime

MAX_UPLOAD = 20 * 1024 * 1024
MAX_UNCOMPRESSED = 100 * 1024 * 1024
MAX_SHEETS = 40
MAX_ROWS = 50_000

ALIASES = {
    "ticker": ("codigo de negociacao", "codigo do ativo", "ticker", "papel", "ativo", "produto"),
    "name": ("nome do ativo", "nome", "empresa", "descricao"),
    "quantity": ("quantidade", "qtd", "saldo"),
    "price": ("preco unitario", "valor unitario", "preco atual", "preco de fechamento", "cotacao", "valor da cota", "preco"),
    "average": ("preco medio", "custo medio", "preco de aquisicao", "preco medio de compra"),
    "invested": ("valor aplicado",),
    "total": ("valor da operacao", "valor atualizado", "valor bruto", "valor de mercado", "valor atual", "valor liquido", "valor total", "total", "valor"),
    "date": ("data da movimentacao", "data do movimento", "data pregao", "previsao de pagamento", "pagamento", "data"),
    "operation": ("tipo de movimentacao", "tipo de movimento", "tipo de evento", "movimentacao", "movimento", "operacao", "entrada saida"),
    "category": ("tipo de ativo", "classe", "categoria", "produto"),
    "institution": ("instituicao", "corretora"),
}

# Abas agregadas por período virariam posições fantasma; o importador as ignora.
IGNORED_SHEETS = ("negociacoes",)

MONTH_WORDS = {
    "janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5, "junho": 6,
    "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12,
}


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
    # Credito/Debito são os tipos de entrada/saída no XLSX de movimentações da B3.
    if "credito" in text:
        return "Compra"
    if "debito" in text:
        return "Venda"
    return "Evento"


# Prefix match cobre variações como "Preço unitário (W)"; trocar por mapa por relatório se um
# export real divergir mais.
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
            # "CDB - CDB9250MG61 - BANCO X": tipo genérico sem dígito e com código no trecho seguinte.
            if not any(char.isdigit() for char in symbol):
                candidate = (name.split(" - ", 1)[0] or "").split()[0].upper() if name else ""
                if len(candidate) <= 12 and any(char.isdigit() for char in candidate):
                    symbol = candidate
            return symbol[:12], name
    # Sem código separado (ex.: "Tesouro Selic 2027") o nome completo é o identificador.
    return text.upper()[:32], ""


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


def parse_br_number(text) -> float | None:
    """Número no formato brasileiro usado pela listagem pública do Fundamentus ('1.234,56%')."""
    value = str(text).strip().replace("%", "").strip()
    if not value or value.upper() in {"N/D", "NA", "-"}:
        return None
    value = value.replace(".", "").replace(",", ".")
    try:
        return float(value)
    except ValueError:
        return None
