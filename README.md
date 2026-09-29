# Pomodoro

A lightweight Windows desktop Pomodoro app for studying, with a YouTube player
synced to the timer: the video **plays during study** and **pauses automatically
on breaks**.

![Stack](https://img.shields.io/badge/stack-Electron%20%2B%20TypeScript-e8622f)
![CI](https://github.com/hugo-leonardo-dev/pomodoro/actions/workflows/ci.yml/badge.svg)

## 📥 Download

Grab the latest build from the
[**Releases**](https://github.com/hugo-leonardo-dev/pomodoro/releases) page:

| File | What it is |
|---|---|
| `Pomodoro-x.y.z-portable.exe` | Single file — double-click and run. No installer, no terminal, no admin rights |
| `Pomodoro-Setup-x.y.z.exe` | Traditional Windows installer (NSIS) with Start Menu shortcut and uninstaller |

> **SmartScreen note:** the binaries are not code-signed, so Windows may show a
> warning on first run. Choose **More info → Run anyway**.

Settings live in `%APPDATA%\pomodoro`, so they survive updates and reinstalls.

## ✨ Features

- ⏱️ Large centered timer built on **real timestamps** (stays accurate when the
  window loses focus or is minimized)
- 🎬 Embedded **YouTube player** (official IFrame Player API — no downloads)
  - Accepts `watch?v=`, `youtu.be`, `shorts`, `embed`, `live` and **playlists** (`list=`)
  - Play/pause synced with the Pomodoro state
  - Clear fallback when autoplay is blocked
- 🔁 Automatic Study → Break → Study transitions with configurable **cycles**
- 🧠 Explicit state machine: `IDLE → STUDYING → PAUSED_STUDY → BREAK → PAUSED_BREAK`
- 📌 **Mini timer (PIP)** — small always-on-top window with the countdown and
  pause control, resizable and draggable
- 🔔 Notification sounds (3 options + volume) and Windows toast notifications
- 📊 Current session, sessions completed today, total study time today
- 💾 Persistent settings (durations, cycles, video URL, theme, sound, mini timer position)
- 🌓 Dark mode (default) and light mode — warm editorial theme, one coral accent
- 🪟 Compact fixed-size window with custom icon
- ⌨️ Shortcuts: `Space` (start/pause/resume), `R` (reset), `S` (skip)

## 🚀 Run in development

```bash
npm install
npm run dev
```

Requirements: Node.js 18+ and npm.

## 📦 Build for Windows

```bash
npm run dist
```

This generates, in `release/`:

- `Pomodoro-Setup-x.y.z.exe` — NSIS installer
- `Pomodoro-x.y.z-portable.exe` — single-file portable executable
- `win-unpacked/Pomodoro.exe` — unpacked build

Icons are generated automatically before packaging (`scripts/generate-icon.mjs`).

## 🤖 CI / Releases

Two GitHub Actions workflows keep everything automated:

| Workflow | Trigger | What it does |
|---|---|---|
| **CI** (`ci.yml`) | push / PR to `main` | Typecheck, build, icon generation and a packaging smoke test on a clean Windows runner |
| **Release** (`release.yml`) | tag `v*` pushed | Syncs `package.json` version from the tag, builds installer + portable and **publishes a GitHub Release with both `.exe` files attached** |

To cut a new release:

```bash
git tag v1.0.1
git push origin v1.0.1
```

That's it — the workflow builds on Windows and publishes the release for you.

## 🗂️ Project layout

```
src/
  main/            # Electron main process (window, IPC, notifications, settings)
  renderer/        # UI (HTML/CSS/TS): state machine, timer, YouTube, sounds, stats
scripts/
  copy-renderer.mjs    # copies renderer assets to dist/
  generate-icon.mjs    # generates the app icon (no external deps)
build/
  icon.png, icon.ico
.github/workflows/    # CI + release automation
```
