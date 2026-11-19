#!/usr/bin/env python3
"""igwatch: turn a short video into ONE contact-sheet image + a timestamped transcript.

Usage: igwatch.py <video file or URL> [outdir]
Token-light by design: one tiled JPEG (12 frames max, timestamps burned in) and plain text.
Speech-to-text runs on this machine (Moonshine via sherpa-onnx) - no API, no key.
"""
import json, os, subprocess, sys, wave

import numpy as np

HOME = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HOME, "sherpa-onnx-moonshine-base-en-int8")


def run(*a):
    return subprocess.run(a, check=True, capture_output=True, text=True).stdout


def fetch(src, out):
    if os.path.exists(src):
        return src, {}
    tmpl = os.path.join(out, "video.%(ext)s")
    cmd = ["yt-dlp", "-q", "--no-warnings", "-f", "mp4/best", "-o", tmpl, "--write-info-json", src]
    cookies = os.environ.get("IGWATCH_COOKIES")
    if cookies and os.path.exists(cookies):
        cmd[1:1] = ["--cookies", cookies]
    subprocess.run(cmd, check=True)
    info = {}
    for f in os.listdir(out):
        if f.endswith(".info.json"):
            d = json.load(open(os.path.join(out, f)))
            info = {k: d.get(k) for k in ("uploader", "channel", "title", "description", "duration", "like_count")}
    vid = next(os.path.join(out, f) for f in os.listdir(out) if f.startswith("video.") and not f.endswith(".json"))
    return vid, info


def sheet(vid, out, dur, n=12):
    n = max(4, min(n, int(dur // 2) or 4))
    times = [dur * (i + 0.5) / n for i in range(n)]
    tiles = []
    for i, t in enumerate(times):
        p = os.path.join(out, f"f{i:02d}.jpg")
        stamp = f"{int(t // 60)}\\:{int(t % 60):02d}"
        run("ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", vid, "-frames:v", "1",
            "-vf", f"scale=-2:420,drawtext=text='{stamp}':x=6:y=6:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6",
            p)
        tiles.append(p)
    cols = 6 if n > 8 else 4
    rows = -(-n // cols)
    inputs = sum((["-i", p] for p in tiles), [])
    grid = os.path.join(out, "sheet.jpg")
    pos = lambda k, u: "+".join([u] * k) or "0"
    layout = "|".join(f"{pos(i % cols, 'w0')}_{pos(i // cols, 'h0')}" for i in range(n))
    run("ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex",
        f"xstack=inputs={n}:layout={layout}:fill=black", "-q:v", "4", grid)
    for p in tiles:
        os.remove(p)
    return grid, rows, cols


def transcript(vid, out, chunk=15):
    wav = os.path.join(out, "a.wav")
    try:
        run("ffmpeg", "-y", "-loglevel", "error", "-i", vid, "-vn", "-ac", "1", "-ar", "16000", wav)
    except subprocess.CalledProcessError:
        return "(no audio track)"
    import sherpa_onnx
    rec = sherpa_onnx.OfflineRecognizer.from_moonshine(
        preprocessor=f"{MODEL}/preprocess.onnx", encoder=f"{MODEL}/encode.int8.onnx",
        uncached_decoder=f"{MODEL}/uncached_decode.int8.onnx",
        cached_decoder=f"{MODEL}/cached_decode.int8.onnx", tokens=f"{MODEL}/tokens.txt", num_threads=4)
    with wave.open(wav) as w:
        sr = w.getframerate()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    os.remove(wav)
    lines = []
    for s in range(0, len(a), chunk * sr):
        seg = a[s:s + chunk * sr]
        if np.abs(seg).max(initial=0) < 0.01:
            continue
        st = rec.create_stream()
        st.accept_waveform(sr, seg)
        rec.decode_stream(st)
        txt = st.result.text.strip()
        if txt:
            t = s // sr
            lines.append(f"[{t // 60}:{t % 60:02d}] {txt}")
    return "\n".join(lines) or "(no speech - music only)"


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.getcwd(), "igwatch-out")
    os.makedirs(out, exist_ok=True)
    vid, info = fetch(src, out)
    dur = float(run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", vid))
    grid, rows, cols = sheet(vid, out, dur)
    text = transcript(vid, out)
    open(os.path.join(out, "transcript.txt"), "w").write(text)
    print(json.dumps({"duration_s": round(dur, 1), "sheet": grid, "grid": f"{rows}x{cols}", **info}))
    print("TRANSCRIPT:\n" + text)


if __name__ == "__main__":
    main()
