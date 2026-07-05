#!/usr/bin/env sh
set -eu

# Set visible window title/app name for Linux bundle.
if [ -f linux/my_application.cc ]; then
  python3 - <<'PY'
from pathlib import Path
p=Path('linux/my_application.cc')
s=p.read_text()
s=s.replace('zephyr_agent', 'Zephyr Agent')
s=s.replace('zephyr-agent', 'Zephyr Agent')
p.write_text(s)
PY
fi
