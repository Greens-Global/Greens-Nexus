#!/bin/bash
# watch-reel: install on demand (~30 s). Everything lands in /root/.cache/igwatch.
set -e
D=/root/.cache/igwatch; M=sherpa-onnx-moonshine-base-en-int8
mkdir -p "$D"
cp "$(dirname "$0")/igwatch.py" "$D/igwatch.py"
python3 -c "import yt_dlp, sherpa_onnx" 2>/dev/null || pip install -q yt-dlp sherpa-onnx
[ -d "$D/$M" ] || curl -sSL "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$M.tar.bz2" | tar xj -C "$D"
echo "watch-reel ready"
