"""Testes do importador de XLSX da Área do Investidor da B3.

Cobrem os layouts reais: consolidado com abas de posição/Tesouro/proventos,
extrato de movimentações com sufixos de edição, dimensão mentirosa ref="A1"
e aba agregada de Negociações que precisa ser ignorada.
"""
from __future__ import annotations

import io
import re
import unittest
from datetime import datetime

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from openpyxl import Workbook

from dorinvest.adapters.b3_xlsx import B3XlsxImporter
from dorinvest.domain.rules import report_date

PARSER = B3XlsxImporter()


class ConsolidatedLayoutTest(unittest.TestCase):
    def test_basic_layout_with_average(self):
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
        parsed = PARSER.parse(data.getvalue(), "Relatorio_Consolidado_teste.xlsx")
        self.assertTrue(parsed["fullSnapshot"])
        self.assertEqual(len(parsed["positions"]), 1)
        self.assertEqual(parsed["positions"][0]["averagePrice"], 32.0)
        self.assertEqual(len(parsed["transactions"]), 2)
        self.assertEqual([tx["type"] for tx in parsed["transactions"]], ["Compra", "Provento"])
        self.assertEqual({tx["category"] for tx in parsed["transactions"]}, {"Ações"})
        self.assertTrue(any("sem data; foram ignoradas" in warning for warning in parsed["warnings"]))
        self.assertEqual(parsed["transactions"][0]["sourceId"], PARSER.parse(data.getvalue(), "Relatorio_Consolidado_teste.xlsx")["transactions"][0]["sourceId"])

    def test_edited_headers_with_suffixes(self):
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
        parsed2 = PARSER.parse(data2.getvalue(), "Relatorio_Consolidado_202610.xlsx")
        self.assertTrue(parsed2["fullSnapshot"] and len(parsed2["positions"]) == 1)
        self.assertEqual(parsed2["positions"][0]["category"], "Ações")
        self.assertEqual(parsed2["positions"][0]["averagePrice"], 61.2)
        self.assertEqual(parsed2["transactions"][0]["type"], "Compra")
        self.assertEqual(parsed2["transactions"][0]["price"], 61.2)

    def test_movements_file_with_bogus_dimension(self):
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
        # Simula o gerador da B3 que declara a dimensão ref="A1" e quebrava o modo read-only.
        content3 = re.sub(rb'<dimension ref="[^"]+"/>', b'<dimension ref="A1"/>', data3.getvalue(), count=1)
        parsed3 = PARSER.parse(content3, "movimentacao-2026-10-28.xlsx")
        self.assertFalse(parsed3["positions"])
        types3 = [tx["type"] for tx in parsed3["transactions"]]
        self.assertEqual(types3[0], "Provento")
        self.assertEqual(types3[1], "Provento")
        self.assertEqual(types3[2], "Compra")
        self.assertEqual(types3[3], "Venda")
        hglg = parsed3["transactions"][0]
        self.assertEqual(hglg["ticker"], "HGLG11")
        self.assertTrue(hglg["name"].startswith("PÁTRIA"))
        self.assertEqual(hglg["quantity"], 0)
        self.assertEqual(hglg["amount"], 32.76)
        self.assertEqual(parsed3["transactions"][2]["ticker"], "ABEV3")
        self.assertEqual(parsed3["transactions"][4]["ticker"], "TESOURO SELIC 2027")
        self.assertEqual(parsed3["transactions"][4]["type"], "Venda")
        self.assertEqual(parsed3["transactions"][5]["ticker"], "CDB9250MG61")
        self.assertEqual(parsed3["transactions"][6]["ticker"], "CDB421FE8B4")
        self.assertEqual(parsed3["referenceDate"], "2026-10-27")
        labels3 = [tx["label"] for tx in parsed3["transactions"]]
        self.assertIn("Fração em Ativos", labels3)
        self.assertIn("Bonificação em Ativos", labels3)
        fracao = next(tx for tx in parsed3["transactions"] if tx["label"] == "Fração em Ativos")
        self.assertEqual(fracao["type"], "Evento")
        self.assertEqual(fracao["quantity"], 2)
        self.assertEqual(fracao["amount"], 0)

    def test_consolidated_real_sheets(self):
        """Abas do consolidado real: posição, Tesouro com custo por Valor Aplicado,
        proventos pagos com data Pagamento, e a aba Negociações (agregados) ignorada."""
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
        parsed4 = PARSER.parse(data4.getvalue(), "relatorio-consolidado-mensal-2026-janeiro.xlsx")
        self.assertTrue(parsed4["fullSnapshot"])
        self.assertEqual(len(parsed4["positions"]), 2)
        by_ticker = {p["ticker"]: p for p in parsed4["positions"]}
        self.assertEqual(by_ticker["ABEV3"]["category"], "Ações")
        self.assertEqual(by_ticker["ABEV3"]["name"], "AMBEV S.A.")
        self.assertIsNone(by_ticker["ABEV3"]["averagePrice"])  # consolidado não traz preço médio de ações
        self.assertEqual(by_ticker["TESOURO SELIC 2027"]["category"], "Renda fixa")
        self.assertAlmostEqual(by_ticker["TESOURO SELIC 2027"]["averagePrice"], 29966.55 / 1.93, delta=0.01)
        self.assertAlmostEqual(by_ticker["TESOURO SELIC 2027"]["currentPrice"], 38591.11 / 1.93, delta=0.01)
        payments = [tx for tx in parsed4["transactions"] if tx["type"] == "Provento"]
        self.assertEqual(len(payments), 1)
        self.assertEqual(payments[0]["ticker"], "BBDC3")
        self.assertEqual(payments[0]["date"], "2026-09-15")
        self.assertEqual(payments[0]["amount"], 97.83)
        self.assertEqual(parsed4["reportDate"], "2026-01-31")
        self.assertEqual(PARSER.parse(data4.getvalue(), "relatorio-consolidado-anual-2025.xlsx")["reportDate"], "2025-12-31")
        self.assertIsNone(report_date("movimentacao-2026-10-28.xlsx"))


if __name__ == "__main__":
    unittest.main()
