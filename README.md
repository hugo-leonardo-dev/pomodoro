# Pomodoro

A lightweight Windows desktop Pomodoro app for studying, with a YouTube player
synced to the timer: the video **plays during study** and **pauses automatically
on breaks**.

![Stack](https://img.shields.io/badge/stack-Electron%20%2B%20TypeScript-e8622f)

## Features

- ⏱️ Large centered timer built on **real timestamps** (stays accurate when the
  window loses focus or is minimized)
- 🎬 Embedded **YouTube player** (official IFrame Player API — no downloads)
  - Accepts `watch?v=`, `youtu.be`, `shorts`, `embed`, `live` and **playlists** (`list=`)
  - Play/pause synced with the Pomodoro state
  - Clear fallback when autoplay is blocked
- 🔁 Automatic Study → Break → Study transitions with configurable **cycles**
- 🧠 Explicit state machine: `IDLE → STUDYING → PAUSED_STUDY → BREAK → PAUSED_BREAK`
- 🔔 Notification sounds (3 options + volume) and Windows toast notifications
- 📊 Current session, sessions completed today, total study time today
- 💾 Persistent settings (durations, cycles, video URL, theme, sound, window position)
- 🌓 Dark mode (default) and light mode
- 📌 **Mini timer** — a small always-on-top window showing the countdown anywhere on screen
- ⌨️ Shortcuts: `Space` (start/pause/resume), `R` (reset), `S` (skip)

## Run in development

```bash
npm install
npm run dev
```

## Build the Windows installer

```bash
npm run dist
```

The NSIS installer and a portable `.exe` are generated in `release/`.

> Requirements: Node.js 18+ and npm. Packaging uses electron-builder (NSIS).

## Project layout

```
src/
  main/            # Electron main process (window, IPC, notifications, settings)
  renderer/        # UI (HTML/CSS/TS): state machine, timer, YouTube, sounds, stats
scripts/
  copy-renderer.mjs
  generate-icon.mjs
build/
  icon.png, icon.ico
```
