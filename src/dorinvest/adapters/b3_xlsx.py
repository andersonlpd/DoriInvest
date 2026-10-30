"""Adapter do importador: XLSX da Área do Investidor da B3.

Só IO acontece aqui (openpyxl + zipfile). Todas as regras de leitura
(cabeçalhos, tipos de operação, classes) moram em dorinvest.domain.rules.
"""
from __future__ import annotations

import hashlib
import io
import zipfile

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from ..domain import rules


class B3XlsxImporter:
    def parse(self, content: bytes, filename: str) -> dict:
        if not content or len(content) > rules.MAX_UPLOAD:
            raise ValueError("O arquivo está vazio ou excede o limite de 20 MB.")
        if not content.startswith(b"PK"):
            raise ValueError("O arquivo não parece ser um XLSX exportado pela B3.")
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                files = archive.infolist()
                if len(files) > 2_000 or sum(item.file_size for item in files) > rules.MAX_UNCOMPRESSED:
                    raise ValueError("A planilha excede os limites de segurança do importador.")
                if any(item.compress_size and item.file_size / item.compress_size > 500 for item in files):
                    raise ValueError("A planilha excede a taxa de compactação permitida.")
            book = load_workbook(io.BytesIO(content), read_only=True, data_only=True, keep_links=False)
        except (zipfile.BadZipFile, InvalidFileException, OSError) as error:
            raise ValueError("Não consegui abrir o XLSX. Baixe novamente o arquivo da Área do Investidor.") from error

        positions, transactions, warnings, snapshot_sheets, sheet_names = [], [], [], [], []
        receivable, undated = False, 0
        try:
            if len(book.worksheets) > rules.MAX_SHEETS:
                raise ValueError("A planilha contém abas demais.")
            for sheet in book.worksheets:
                sheet_names.append(sheet.title[:80])
                normalized_sheet_title = rules.normalize(sheet.title)
                sheet.reset_dimensions()  # reports B3 declaram a dimensão "A1" mentirosa; o alcance real vem do stream
                if normalized_sheet_title.startswith(rules.IGNORED_SHEETS):
                    warnings.append("Aba {} ignorada: valores agregados por período; use o arquivo de Movimentações ou lance a operação manualmente.".format(sheet.title[:40]))
                    continue
                found = None
                for row_index, row in enumerate(sheet.iter_rows(min_row=1, max_row=30, values_only=True), 1):
                    cols = rules.columns_for(row)
                    if "ticker" in cols and "quantity" in cols and any(key in cols for key in ("price", "total", "operation")):
                        found = (row_index, cols)
                        break
                if not found:
                    continue
                header_row, cols = found
                header_text = " ".join(rules.normalize(value) for value in sheet.iter_rows(min_row=header_row, max_row=header_row, values_only=True).__next__())
                if "previsao de pagamento" in header_text or "proventos a receber" in rules.normalize(sheet.title):
                    receivable = True
                is_movement = "operation" in cols and "date" in cols
                sheet_name = sheet.title[:80]
                if not is_movement and any(key in cols for key in ("price", "total")):
                    snapshot_sheets.append(rules.normalize(sheet_name))

                for row_index, row in enumerate(sheet.iter_rows(min_row=header_row + 1, values_only=True), header_row + 1):
                    if row_index > rules.MAX_ROWS:
                        warnings.append("Aba {} limitada a {} linhas.".format(sheet_name, rules.MAX_ROWS))
                        break
                    ticker, asset_name = rules.split_ticker(str(rules.cell(row, cols, "ticker") or ""))
                    qty = rules.number(rules.cell(row, cols, "quantity"))
                    kind = rules.operation_type(rules.cell(row, cols, "operation")) if is_movement else None
                    if qty is None and kind == "Provento":
                        qty = 0
                    if not ticker or qty is None or qty < 0:
                        continue
                    name = asset_name or str(rules.cell(row, cols, "name") or ticker).strip()
                    asset_class = rules.category(rules.cell(row, cols, "category"), sheet_name)
                    price = rules.number(rules.cell(row, cols, "price"))
                    total = rules.number(rules.cell(row, cols, "total"))
                    average = rules.number(rules.cell(row, cols, "average"))
                    invested = rules.number(rules.cell(row, cols, "invested"))
                    event_date = rules.iso_date(rules.cell(row, cols, "date"))
                    if is_movement and not event_date:
                        undated += 1
                        continue
                    institution = str(rules.cell(row, cols, "institution") or "").strip()

                    if is_movement:
                        quantity = 0 if kind == "Provento" else abs(qty)
                        unit_price = (total or price or 0) if kind == "Provento" else (price if price is not None else ((total / quantity) if total is not None and quantity else 0))
                        amount = (total if total is not None else unit_price) if kind == "Provento" else (total if total is not None else quantity * unit_price)
                        stable = "|".join(str(v or "") for v in (event_date, ticker, kind, quantity, unit_price, amount, institution))
                        transactions.append({"sourceId": hashlib.sha256(stable.encode()).hexdigest(), "date": event_date, "ticker": ticker, "name": name, "category": asset_class, "type": kind, "quantity": quantity, "price": unit_price, "amount": amount, "label": str(rules.cell(row, cols, "operation") or "")[:64], "source": "B3 XLSX"})
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
                        product_text = str(rules.cell(row, cols, "category") or "").strip()
                        nice_name = asset_name or (product_text.partition(" - ")[2].strip() if " - " in product_text else product_text)
                        positions.append({"ticker": ticker, "name": nice_name or name, "category": asset_class, "quantity": qty, "averagePrice": per_unit_cost, "currentPrice": current_price, "currentValue": total if total is not None else qty * current_price, "source": "B3"})
        finally:
            book.close()

        # Agrupa tickers repetidos por instituição sem inventar custo médio ausente.
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
        import_name = rules.normalize(filename)
        full_snapshot = bool(snapshot) and ("consolidado" in import_name or any(any(term in sheet for term in ("consolidado", "posicao", "investimento")) for sheet in snapshot_sheets))
        if snapshot and not full_snapshot:
            warnings.append("O relatório parece um recorte por aba/filtro; posições B3 não incluídas serão preservadas.")
        kind = "proventos" if receivable and not snapshot else "relatorio"
        if undated:
            warnings.append("{} linha(s) sem data; foram ignoradas.".format(undated))
        if kind == "proventos":
            warnings.append("Proventos a receber: as datas são previsões da B3 e a carteira não é alterada por este arquivo.")
        elif transactions and not snapshot:
            warnings.append("Este arquivo não contém snapshot de posição; o histórico será adicionado sem recalcular o saldo atual.")
        reference = None if kind == "proventos" else max((tx["date"] for tx in transactions if tx["date"]), default=None)
        return {"importId": hashlib.sha256(content).hexdigest(), "source": "B3 XLSX", "kind": kind, "referenceDate": reference, "reportDate": rules.report_date(filename), "fullSnapshot": full_snapshot, "positions": snapshot, "transactions": transactions, "sheetNames": sheet_names, "warnings": warnings}
