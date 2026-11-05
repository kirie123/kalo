"""全局数据目录；KALO_HOME 为完整的绝对路径。"""
import os
from pathlib import Path


def kalo_home() -> Path:
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or str(Path.home())
    root = Path(os.environ.get("KALO_HOME") or str(Path(home) / ".kalo"))
    if not root.is_absolute():
        raise ValueError("KALO_HOME 必须是绝对路径")
    return root
