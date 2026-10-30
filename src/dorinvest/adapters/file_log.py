"""Adapter de log: erros reportados pelo navegador vão para um arquivo local."""
from __future__ import annotations

import json
from pathlib import Path


class FileEventLog:
    def __init__(self, path: Path):
        self.path = Path(path)

    def append(self, record: dict) -> None:
        try:
            if self.path.exists() and self.path.stat().st_size > 200_000:
                self.path.write_text("\n".join(self.path.read_text().splitlines()[-50:]) + "\n", encoding="utf-8")
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass
