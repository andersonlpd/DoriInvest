"""Piloto de sincronização com a Área do Investidor da B3.

O navegador é controlado por um helper Node/Playwright (tools/b3sync.mjs) que
mantém um perfil persistente. Este serviço só orquestra: inicia o helper, lista
os XLSX capturados em data/b3-inbox, entrega o arquivo para o importador
existente e arquiva o que já foi aplicado em data/b3-inbox/processed.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

ACTIVE_STATES = {"starting", "waiting_login", "ready", "downloaded"}
SAFE_NAME = re.compile(r"^[\w.\- ]+\.xlsx$", re.IGNORECASE)


class B3SyncService:
    def __init__(self, data_dir: Path, root: Path):
        self.data_dir = Path(data_dir)
        self.root = Path(root)
        self.inbox = self.data_dir / "b3-inbox"
        self.processed = self.inbox / "processed"
        self.status_path = self.data_dir / "b3-sync.json"
        self.log_path = self.data_dir / "b3-sync.log"
        self.lock_path = self.data_dir / "b3-sync.lock"
        self.script = self.root / "tools" / "b3sync.mjs"
        self.inbox.mkdir(parents=True, exist_ok=True)
        self.processed.mkdir(parents=True, exist_ok=True)

    def _read_status(self) -> dict:
        try:
            data = json.loads(self.status_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write_status(self, patch: dict) -> None:
        status = self._read_status()
        status.update(patch)
        status["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        tmp = self.status_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.status_path)

    def _running(self) -> bool:
        try:
            pid = int(self.lock_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            try:
                self.lock_path.unlink()
            except OSError:
                pass
            return False

    def status(self) -> dict:
        status = self._read_status()
        files = []
        for path in sorted(self.inbox.glob("*.xlsx"), key=lambda item: item.stat().st_mtime, reverse=True):
            if not path.is_file():
                continue
            stat = path.stat()
            files.append({
                "name": path.name,
                "size": stat.st_size,
                "modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime)),
            })
        status["files"] = files
        status["running"] = self._running()
        status["processed"] = len(list(self.processed.glob("*.xlsx")))
        status["inbox"] = str(self.inbox.relative_to(self.root)) if self.inbox.is_relative_to(self.root) else str(self.inbox)
        return status

    def start(self, mode: str) -> dict:
        if mode not in ("login", "sync"):
            raise ValueError("Modo de sincronização inválido.")
        if self._running():
            raise ValueError("Já existe uma janela de sincronização aberta.")
        node = shutil.which("node")
        if not node:
            raise ValueError("Node.js não encontrado. O piloto de sincronização precisa de Node e Playwright instalados.")
        if not self.script.exists():
            raise ValueError("Helper de sincronização ausente em tools/b3sync.mjs.")
        log_handle = open(self.log_path, "a", encoding="utf-8")
        process = subprocess.Popen(
            [node, str(self.script), mode],
            cwd=str(self.root),
            stdout=log_handle,
            stderr=log_handle,
            env={**os.environ, "B3SYNC_MODE": mode},
            start_new_session=True,
        )
        self.lock_path.write_text(str(process.pid), encoding="utf-8")
        self._write_status({
            "mode": mode,
            "state": "starting",
            "message": "Abrindo o navegador controlado…",
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        })
        return {"started": True, "pid": process.pid, "mode": mode}

    def resolve(self, name: str) -> Path:
        base = str(name or "").strip()
        if not SAFE_NAME.match(base):
            raise ValueError("Nome de arquivo inválido.")
        path = (self.inbox / base).resolve()
        if path.parent != self.inbox.resolve() or not path.is_file():
            raise ValueError("Arquivo não encontrado na pasta de importação.")
        return path

    def ack(self, names: list) -> int:
        moved = 0
        for name in names or []:
            try:
                source = self.resolve(name)
            except ValueError:
                continue
            target = self.processed / source.name
            counter = 2
            while target.exists():
                target = self.processed / (source.stem + "-" + str(counter) + source.suffix)
                counter += 1
            try:
                source.replace(target)
                moved += 1
            except OSError:
                continue
        return moved
