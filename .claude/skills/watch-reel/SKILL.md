---
name: watch-reel
description: Watch an Instagram reel (or any short video file or link) in the fewest tokens - one timestamped contact-sheet image plus an on-device transcript - then judge what applies to Nexus. Use when Neil sends an instagram.com/reel or /p link, a video file, or says "review this video".
---

# Watch a reel

Goal: see and hear a short video cheaply, with no waiting. Output is ONE image
(12 frames max, times burned in) and plain text. Never read individual frames, never
read the video bytes, never fetch the Instagram page HTML into context.

## Steps

1. `bash .claude/skills/watch-reel/setup.sh` (skip if `/root/.cache/igwatch/igwatch.py`
   exists). It installs yt-dlp, sherpa-onnx and the Moonshine speech model from
   GitHub - on-device speech-to-text, no API, never the Anthropic key.
2. Cookies: Instagram sends anonymous cloud requests to its login page. Neil's
   cookies file (Netscape `cookies.txt` from a browser signed in to Instagram) goes to
   `/root/.cache/igwatch/cookies.txt` with `chmod 600`, then
   `export IGWATCH_COOKIES=/root/.cache/igwatch/cookies.txt`. It is a live login:
   never print it, commit it, copy it into the repo or send it anywhere but Instagram.
   No file this session = ask Neil to attach it (or the video itself) once.
3. `python3 /root/.cache/igwatch/igwatch.py "<link or file>" <scratchpad>/<shortcode>`
   prints JSON (duration, sheet path, caption, uploader) and the transcript.
4. Read the one `sheet.jpg`. If on-screen text is too small, re-extract only the
   frame you need at full size with ffmpeg - never all of them.
5. A video file Neil attaches works the same way (pass the path); no login needed.

## Network

The `greens-nexus` environment allows `www.instagram.com`, `i.instagram.com`,
`scontent.cdninstagram.com`, `www.youtube.com`, `youtube.com`, `m.youtube.com`,
`youtu.be`, `i.ytimg.com` and `youtubei.googleapis.com`. The video bytes come from
servers whose names change every request, so they need wildcards that only Neil can
add (Settings > the environment > Network access > Allowed domains):
`*.googlevideo.com` (YouTube), `*.cdninstagram.com` and `*.fbcdn.net` (Instagram).
Until they are there, a YouTube link still gives title, description and captions
(`yt-dlp --skip-download --write-auto-subs --sub-langs "en.*"`) - say that the frames
are missing. Never fake Instagram's or YouTube's app headers or use third-party
downloader sites to get around a login.

## Long videos

12 frames is the budget for any length. For a long YouTube video read
`transcript.txt` in sections, and pull an extra frame only where the words point at
something on screen.

## Then

Map each idea to what Nexus already has (CLAUDE.md) before proposing anything, check
it against Neil's standing decisions (no "Claude rectangle" design, AI off, one
"+ New", sheets from the right), and plan with before / after mockups before code.
