#!/usr/bin/env python3
"""Atalho de execução: python3 run.py --port 8000"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from dorinvest.main import main  # noqa: E402

main()
