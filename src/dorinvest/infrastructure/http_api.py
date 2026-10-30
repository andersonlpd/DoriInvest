"""Driver HTTP: http.server da biblioteca padrão com as rotas da aplicação.

Os serviços da aplicação chegam injetados via build_handler(); nada aqui conhece
SQLite, brapi ou Fundamentus. O frontend é servido da pasta frontend/ (index,
css e módulos js).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

CONFIG: dict = {}


def build_handler(services: dict, frontend_dir: Path, data_dir: Path) -> type:
    CONFIG["services"] = services
    CONFIG["frontend"] = frontend_dir
    CONFIG["data"] = data_dir

    class Handler(BaseHTTPRequestHandler):
        CONTENT = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }

        def _file(self, path: Path, status: int = 200) -> None:
            body = path.read_bytes()
            self.send_response(status)
            self.send_header("Content-Type", self.CONTENT.get(path.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            services = CONFIG["services"]
            parsed = urlsplit(self.path)
            self.path = parsed.path
            query = parse_qs(parsed.query)
            frontend = CONFIG["frontend"]
            if self.path == "/api/health":
                return self._json(200, {"status": "ok", "storage": "sqlite", "quotes": "brapi.dev", "quoteApiKeyConfigured": services["quotes"].provider.api_key_configured(), "marketLists": "fundamentus"})
            if self.path == "/api/state":
                return self._json(200, services["portfolio"].get_state())
            if self.path == "/api/history":
                ticker = (query.get("ticker") or [""])[0]
                try:
                    days = int((query.get("days") or ["30"])[0])
                except ValueError:
                    days = 30
                try:
                    return self._json(200, services["quotes"].history(ticker, days))
                except ValueError as error:
                    return self._json(422, {"error": str(error)})
                except Exception:
                    return self._json(503, {"error": "Histórico de preços indisponível agora."})
            if self.path == "/api/benchmarks":
                start = (query.get("start") or [""])[0]
                end = (query.get("end") or [""])[0]
                try:
                    return self._json(200, services["benchmarks"].series(start, end))
                except (ValueError, TypeError):
                    return self._json(422, {"error": "Informe datas válidas para o comparativo (start e end em AAAA-MM-DD)."})
                except Exception:
                    return self._json(503, {"error": "Comparativo indisponível agora."})
            if self.path == "/api/rankings":
                try:
                    return self._json(200, services["market"].ranking_rows())
                except (Exception, ValueError, TimeoutError) as error:
                    return self._json(503, {"error": "Listagem de mercado indisponível agora ({}).".format(type(error).__name__)})
            if self.path in {"/", "/index.html"}:
                try:
                    return self._file(frontend / "index.html")
                except OSError:
                    return self._json(500, {"error": "Frontend não encontrado no servidor local."})
            # Módulos do frontend (js e css) sob caminho controlado, sem ../
            candidate = (frontend / self.path.lstrip("/")).resolve()
            try:
                candidate.relative_to(frontend.resolve())
            except ValueError:
                return self._json(404, {"error": "Não encontrado."})
            if candidate.is_file() and candidate.suffix in self.CONTENT:
                return self._file(candidate)
            return self._json(404, {"error": "Não encontrado."})

        def do_POST(self):
            services = CONFIG["services"]
            self.path = urlsplit(self.path).path
            routes = {
                "/api/log": ("log", "Registro de erro inválido."),
                "/api/quotes": ("quotes", "Não consegui processar a solicitação de cotações."),
                "/api/state": ("state", "Não consegui salvar o estado."),
                "/api/b3/import": ("import", "Não consegui ler esse XLSX. Nenhum dado da carteira foi alterado."),
            }
            route = routes.get(self.path)
            if route is None:
                return self._json(404, {"error": "Não encontrado."})
            service_name, generic_message = route
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b""
                if service_name == "log":
                    return self._json(200, {"saved": services["log"].record(raw)})
                if service_name == "quotes":
                    return self._json(200, services["quotes"].refresh(json.loads(raw) if raw else None, len(raw)))
                if service_name == "state":
                    services["portfolio"].save_state(raw)
                    return self._json(200, {"saved": True, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
                if service_name == "import":
                    if length < 1 or length > 20 * 1024 * 1024:
                        raise ValueError("Envie um XLSX válido de até 20 MB.")
                    filename = Path(unquote(self.headers.get("X-B3-Filename", "relatorio.xlsx"))).name[:120]
                    return self._json(200, services["import"].parse(raw, filename))
            except ValueError as error:
                return self._json(422, {"error": str(error)})
            except Exception as error:
                print("[DorInvest] erro em {}: {}".format(self.path, type(error).__name__))
                return self._json(400, {"error": generic_message})

        def log_message(self, fmt, *args):
            print("[DorInvest] " + fmt % args)

    return Handler
