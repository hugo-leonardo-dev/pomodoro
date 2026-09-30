/**
 * Pomodoro — renderer logic
 * State machine + timestamp-based timer + YouTube IFrame API player.
 */

export {}; // garante que este arquivo seja tratado como módulo ES

// ============================================================ tipos
type Phase = 'IDLE' | 'STUDYING' | 'PAUSED_STUDY' | 'BREAK' | 'PAUSED_BREAK';

type SoundName = 'chime' | 'ding' | 'glass';

type AppSettings = {
  studyMinutes: number;
  breakMinutes: number;
  cycles: number;
  videoUrl: string;
  theme: 'dark' | 'light';
  sound: SoundName;
  volume: number;
  miniOpen?: boolean;
};

type DailyStats = {
  date: string; // YYYY-MM-DD
  completed: number;
  studiedMs: number;
};

declare global {
  interface Window {
    pomo: {
      getSettings: () => Promise<AppSettings>;
      setSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>;
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      notify: (body: string) => void;
      toggleMini: () => void;
      miniPushState: (state: unknown) => void;
      miniOnState: (cb: (state: any) => void) => void;
      miniControl: (action: 'pause-toggle' | 'reset' | 'close' | 'show-main') => void;
      onMiniControl: (cb: (action: string) => void) => void;
      onMiniClosed: (cb: () => void) => void;
    };
  }
}

// YT IFrame API (definida pelo script oficial carregado dinamicamente)
declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// ============================================================ constantes
const TICK_MS = 200;
const STATS_KEY = 'pomo.stats.v1';
const PHASE_LABEL: Record<Phase, string> = {
  IDLE: 'READY',
  STUDYING: 'STUDY',
  PAUSED_STUDY: 'STUDY · PAUSED',
  BREAK: 'BREAK',
  PAUSED_BREAK: 'BREAK · PAUSED',
};

// ============================================================ estado
let phase: Phase = 'IDLE';
let phaseEndsAt = 0; // timestamp (ms) em que a fase atual termina
let remainingMs = 0; // usado quando pausado
let currentCycle = 1;
let totalCycles = 4;
let tickHandle: number | null = null;

let settings: AppSettings = {
  studyMinutes: 50,
  breakMinutes: 10,
  cycles: 4,
  videoUrl: '',
  theme: 'dark',
  sound: 'chime',
  volume: 0.6,
};

// ============================================================ helpers DOM
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const el = {
  modeChip: $('modeChip'),
  timerDisplay: $('timerDisplay'),
  stateLabel: $('stateLabel'),
  cycleInfo: $('cycleInfo'),
  timerCard: $('timerCard'),
  btnStart: $('btnStart') as HTMLButtonElement,
  btnPause: $('btnPause') as HTMLButtonElement,
  btnSkip: $('btnSkip') as HTMLButtonElement,
  btnReset: $('btnReset') as HTMLButtonElement,
  btnTheme: $('btnTheme'),
  btnPip: $('btnPip'),
  studyInput: $('studyInput') as HTMLInputElement,
  breakInput: $('breakInput') as HTMLInputElement,
  cyclesInput: $('cyclesInput') as HTMLInputElement,
  soundSelect: $('soundSelect') as HTMLSelectElement,
  volumeRange: $('volumeRange') as HTMLInputElement,
  btnTestSound: $('btnTestSound'),
  videoUrlInput: $('videoUrlInput') as HTMLInputElement,
  btnLoadVideo: $('btnLoadVideo'),
  videoStatus: $('videoStatus'),
  playerMount: $('playerMount'),
  playerPlaceholder: $('playerPlaceholder'),
  statCurrent: $('statCurrent'),
  statCompleted: $('statCompleted'),
  statTotal: $('statTotal'),
  btnMinimize: $('btnMinimize'),
  btnClose: $('btnClose'),
};

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

const fmtClock = (ms: number): string => {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const fmtHuman = (ms: number): string => {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m} min`;
};

const todayKey = (): string => new Date().toISOString().slice(0, 10);

// ============================================================ estatísticas do dia
function loadStats(): DailyStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DailyStats;
      if (parsed.date === todayKey()) return parsed;
    }
  } catch {
    /* ignora e recria */
  }
  return { date: todayKey(), completed: 0, studiedMs: 0 };
}

let stats = loadStats();

function saveStats(): void {
  localStorage.setItem(STATS_KEY, JSON.stringify(stats));
}

function renderStats(): void {
  el.statCompleted.textContent = String(stats.completed);
  el.statTotal.textContent = fmtHuman(stats.studiedMs);
  el.statCurrent.textContent = `${currentCycle}/${totalCycles}`;
  el.cycleInfo.textContent = `Session: ${currentCycle}/${totalCycles}`;
}

// ============================================================ som (WebAudio)
let audioCtx: AudioContext | null = null;

function playSound(kind: SoundName): void {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const ctx = audioCtx;
    const now = ctx.currentTime;

    const tone = (freq: number, start: number, dur: number, type: OscillatorType): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(settings.volume, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    };

    if (kind === 'ding') {
      tone(880, 0, 0.5, 'sine');
    } else if (kind === 'glass') {
      tone(1318.5, 0, 0.6, 'sine');
      tone(1567.9, 0.12, 0.6, 'sine');
      tone(2093, 0.24, 0.8, 'sine');
    } else {
      // chime: dois tons descendo
      tone(987.77, 0, 0.45, 'sine');
      tone(659.25, 0.18, 0.6, 'sine');
    }
  } catch (err) {
    console.warn('Failed to play sound:', err);
  }
}

// ============================================================ YouTube
let ytPlayer: any = null;
let ytReady = false;
let ytPendingLoad: { videoId?: string; listId?: string } | null = null;
let autoplayHintShown = false;

/** Extrai { videoId, listId } de URLs do YouTube (vídeo, youtu.be, embed, playlist). */
function parseYouTubeUrl(raw: string): { videoId?: string; listId?: string } | null {
  const url = raw.trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const isYT =
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'youtu.be' ||
    host === 'music.youtube.com';
  if (!isYT) return null;

  const result: { videoId?: string; listId?: string } = {};

  if (host === 'youtu.be') {
    result.videoId = parsed.pathname.slice(1).split('/')[0] || undefined;
  } else {
    result.videoId = parsed.searchParams.get('v') || undefined;
    const embedMatch = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/);
    if (!result.videoId && embedMatch) result.videoId = embedMatch[1];
  }

  const list = parsed.searchParams.get('list');
  if (list && !list.startsWith('RD')) result.listId = list; // ignora mixtapes RD*

  if (!result.videoId && !result.listId) return null;
  return result;
}

function loadIframeApi(): void {
  if (window.YT?.Player) {
    ytReady = true;
    return;
  }
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => {
    setVideoStatus('Could not reach YouTube. Check your internet connection.', 'error');
  };
  document.head.appendChild(tag);
  window.onYouTubeIframeAPIReady = () => {
    ytReady = true;
    if (ytPendingLoad) {
      const pending = ytPendingLoad;
      ytPendingLoad = null;
      createPlayer(pending);
    }
  };
}

function setVideoStatus(text: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  el.videoStatus.textContent = text;
  el.videoStatus.classList.remove('hidden', 'ok', 'error');
  if (kind !== 'info') el.videoStatus.classList.add(kind);
}

function createPlayer(target: { videoId?: string; listId?: string }): void {
  const YT = window.YT;
  if (!YT?.Player) {
    ytPendingLoad = target;
    // A API ainda está baixando (ou falhou). Em vez de ficar mudo, avisa —
    // o onYouTubeIframeAPIReady (ou a retry abaixo) conclui o carregamento.
    if (!ytReady) {
      setVideoStatus('Loading YouTube player…', 'info');
      window.setTimeout(() => {
        if (!window.YT?.Player) {
          setVideoStatus('YouTube player did not load. Check your internet connection and reload.', 'error');
        }
      }, 8000);
    }
    return;
  }

  el.playerPlaceholder.classList.add('hidden');
  el.playerMount.classList.remove('hidden');

  const playerVars: Record<string, unknown> = {
    autoplay: 0,
    disablekb: 1,
    modestbranding: 1,
    rel: 0,
    playsinline: 1,
  };

  const cfg: Record<string, unknown> = {
    width: '100%',
    height: '100%',
    playerVars,
    events: {
      onReady: () => {
        if (phase === 'STUDYING') tryPlayVideo();
      },
      onStateChange: (e: { data: number }) => {
        // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
        if (e.data === 1) {
          autoplayHintShown = true; // usuário já destravou o player
          if (el.videoStatus.classList.contains('error')) setVideoStatus('');
        }
        // se o usuário pausar manualmente durante o estudo, avisa sutilmente
      },
      onError: (e: { data: number }) => {
        const map: Record<number, string> = {
          2: 'Invalid video URL.',
          5: 'HTML5 player error. Try another video.',
          100: 'Video not found or private.',
          101: 'This video does not allow embedding. Try another one.',
          150: 'This video does not allow embedding. Try another one.',
          152: 'This video cannot be played here (embed blocked for this origin). Try another video.',
          153: 'Player configuration error (referrer blocked). If it persists, check antivirus/network proxy.',
        };
        setVideoStatus(map[e.data] ?? `YouTube error (code ${e.data}).`, 'error');
      },
    },
  };

  if (target.listId) {
    playerVars.listType = 'playlist';
    playerVars.list = target.listId;
    if (target.videoId) playerVars.index = 0;
    cfg.playerVars = playerVars;
  } else if (target.videoId) {
    cfg.videoId = target.videoId;
  }

  if (ytPlayer) {
    ytPlayer.destroy();
    ytPlayer = null;
  }
  // o mount é substituído por um iframe; recriamos o div interno
  el.playerMount.innerHTML = '<div id="ytPlayer"></div>';
  cfg.elementId = undefined;
  ytPlayer = new YT.Player('ytPlayer', cfg);
  setVideoStatus('Video loaded. Plays on study, pauses on breaks.', 'ok');
}

function loadVideoFromInput(): void {
  const parsed = parseYouTubeUrl(el.videoUrlInput.value);
  if (!parsed) {
    setVideoStatus('Invalid URL. Try https://www.youtube.com/watch?v=… or https://youtu.be/…', 'error');
    return;
  }
  void window.pomo.setSettings({ videoUrl: el.videoUrlInput.value.trim() });
  createPlayer(parsed);
}

function tryPlayVideo(): void {
  if (!ytPlayer?.playVideo) return;
  try {
    ytPlayer.playVideo();
  } catch {
    return;
  }
  // Fallback de autoplay: se continuar "unstarted", pede interação manual
  if (!autoplayHintShown) {
    window.setTimeout(() => {
      try {
        const state = ytPlayer?.getPlayerState?.();
        if (state === -1 || state === 5) {
          setVideoStatus('Autoplay blocked — click the video once to unlock sound.', 'info');
        }
      } catch {
        /* ignora */
      }
    }, 1800);
  }
}

function tryPauseVideo(): void {
  if (!ytPlayer?.pauseVideo) return;
  try {
    ytPlayer.pauseVideo();
  } catch {
    /* ignora */
  }
}

// ============================================================ renderização
function renderTimer(): void {
  let displayMs: number;
  let cssClass: string;

  if (phase === 'IDLE') {
    displayMs = settings.studyMinutes * 60_000;
    cssClass = '';
  } else if (phase === 'PAUSED_STUDY' || phase === 'PAUSED_BREAK') {
    displayMs = remainingMs;
    cssClass = 'paused';
  } else {
    displayMs = phaseEndsAt - Date.now();
    cssClass = phase === 'STUDYING' ? 'study' : 'break';
  }

  el.timerDisplay.textContent = fmtClock(displayMs);
  el.timerDisplay.className = `timer-display ${cssClass}`;

  el.modeChip.textContent = PHASE_LABEL[phase];
  el.modeChip.className =
    'mode-chip ' +
    (phase === 'STUDYING'
      ? 'mode-study'
      : phase === 'BREAK'
        ? 'mode-break'
        : phase.startsWith('PAUSED')
          ? 'mode-paused'
          : 'mode-idle');

  el.timerCard.classList.toggle('study', phase === 'STUDYING');
  el.timerCard.classList.toggle('break', phase === 'BREAK');

  const labels: Record<Phase, string> = {
    IDLE: `Set for a ${settings.studyMinutes} min study session`,
    STUDYING: 'Focus — the video is playing.',
    PAUSED_STUDY: 'Study paused — the video paused too.',
    BREAK: 'Break — relax, the video is paused.',
    PAUSED_BREAK: 'Break paused.',
  };
  el.stateLabel.textContent = labels[phase];

  el.btnStart.disabled = phase !== 'IDLE';
  el.btnSkip.disabled = phase === 'IDLE';
  el.btnReset.disabled = phase === 'IDLE';
  const paused = phase === 'PAUSED_STUDY' || phase === 'PAUSED_BREAK';
  el.btnPause.disabled = !paused && phase !== 'STUDYING' && phase !== 'BREAK';
  el.btnPause.textContent = paused ? '▶ Retomar' : '⏸ Pausar';

  pushMini();
}

// ============================================================ mini timer (PIP)
function pushMini(): void {
  const running = phase === 'STUDYING' || phase === 'BREAK';
  window.pomo.miniPushState({
    phase,
    endAt: running ? phaseEndsAt : 0,
    remainingMs,
    currentCycle,
    totalCycles,
  });
}

function updatePipButton(): void {
  el.btnPip.classList.toggle('active', settings.miniOpen === true);
}

function togglePip(): void {
  settings.miniOpen = !(settings.miniOpen === true);
  updatePipButton();
  void window.pomo.setSettings({ miniOpen: settings.miniOpen });
  window.pomo.toggleMini();
}

function tick(): void {
  if (phase === 'STUDYING' || phase === 'BREAK') {
    const remaining = phaseEndsAt - Date.now();
    if (remaining <= 0) {
      completePhase();
      return;
    }
    el.timerDisplay.textContent = fmtClock(remaining);
  }
}

function startTicking(): void {
  stopTicking();
  tickHandle = window.setInterval(tick, TICK_MS);
}

function stopTicking(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

// ============================================================ máquina de estados
function beginStudy(): void {
  phase = 'STUDYING';
  phaseEndsAt = Date.now() + settings.studyMinutes * 60_000;
  startTicking();
  renderTimer();
  renderStats();
  tryPlayVideo(); // vídeo volta a tocar no estudo
}

function beginBreak(): void {
  phase = 'BREAK';
  phaseEndsAt = Date.now() + settings.breakMinutes * 60_000;
  startTicking();
  renderTimer();
  tryPauseVideo(); // vídeo pausa no break
}

function completePhase(): void {
  stopTicking();
  if (phase === 'STUDYING') {
    // sessão de estudo concluída naturalmente
    stats.completed += 1;
    stats.studiedMs += settings.studyMinutes * 60_000;
    saveStats();
    renderStats();
    playSound(settings.sound);
    window.pomo.notify('Study session complete! Time for a break.');
    if (currentCycle < totalCycles) {
      beginBreak();
    } else {
      // run completa
      phase = 'IDLE';
      renderTimer();
      tryPauseVideo();
      el.stateLabel.textContent = `Nice work! ${totalCycles} cycles done. 🎉`;
    }
  } else if (phase === 'BREAK') {
    playSound(settings.sound);
    window.pomo.notify('Break is over! Time to study.');
    currentCycle += 1;
    beginStudy();
  }
}

function onStart(): void {
  if (phase !== 'IDLE') return;
  currentCycle = 1;
  beginStudy();
}

function onPauseToggle(): void {
  if (phase === 'STUDYING' || phase === 'BREAK') {
    remainingMs = Math.max(0, phaseEndsAt - Date.now());
    const wasStudy = phase === 'STUDYING';
    phase = wasStudy ? 'PAUSED_STUDY' : 'PAUSED_BREAK';
    stopTicking();
    renderTimer();
    tryPauseVideo(); // pausar Pomodoro ⇒ pausar vídeo
  } else if (phase === 'PAUSED_STUDY' || phase === 'PAUSED_BREAK') {
    const isStudy = phase === 'PAUSED_STUDY';
    phase = isStudy ? 'STUDYING' : 'BREAK';
    phaseEndsAt = Date.now() + remainingMs;
    startTicking();
    renderTimer();
    if (isStudy) tryPlayVideo(); // retomar estudo ⇒ retomar vídeo
  }
}

function onSkip(): void {
  if (phase === 'IDLE') return;
  stopTicking();
  const wasStudy = phase === 'STUDYING' || phase === 'PAUSED_STUDY';
  if (wasStudy) {
    // pular estudo ⇒ vai direto para o break (sem contar como concluída)
    playSound(settings.sound);
    window.pomo.notify('Study skipped. Time for a break.');
    beginBreak();
  } else {
    // pular break ⇒ próxima sessão de estudo
    playSound(settings.sound);
    window.pomo.notify('Break skipped. Time to study!');
    if (currentCycle < totalCycles) {
      currentCycle += 1;
      beginStudy();
    } else {
      phase = 'IDLE';
      renderTimer();
      el.stateLabel.textContent = `Nice work! ${totalCycles} cycles done. 🎉`;
    }
  }
}

function onReset(): void {
  stopTicking();
  phase = 'IDLE';
  remainingMs = 0;
  currentCycle = 1;
  renderTimer();
  renderStats();
  tryPauseVideo(); // vídeo em estado coerente: pausado no IDLE
}

// ============================================================ configurações
function applyTheme(): void {
  document.body.classList.toggle('theme-dark', settings.theme === 'dark');
  document.body.classList.toggle('theme-light', settings.theme === 'light');
  // Ícone sol/lua alternado via CSS (body.theme-*), sem tocar no DOM do botão.
}

function fillSettingsInputs(): void {
  el.studyInput.value = String(settings.studyMinutes);
  el.breakInput.value = String(settings.breakMinutes);
  el.cyclesInput.value = String(settings.cycles);
  el.soundSelect.value = settings.sound;
  el.volumeRange.value = String(Math.round(settings.volume * 100));
  el.videoUrlInput.value = settings.videoUrl;
  totalCycles = settings.cycles;
}

function persistTimerSettings(): void {
  const study = clamp(Math.round(Number(el.studyInput.value) || settings.studyMinutes), 1, 180);
  const brk = clamp(Math.round(Number(el.breakInput.value) || settings.breakMinutes), 1, 60);
  const cycles = clamp(Math.round(Number(el.cyclesInput.value) || settings.cycles), 1, 20);
  settings.studyMinutes = study;
  settings.breakMinutes = brk;
  settings.cycles = cycles;
  totalCycles = cycles;
  void window.pomo.setSettings({ studyMinutes: study, breakMinutes: brk, cycles });
  if (phase === 'IDLE') renderTimer();
  renderStats();
}

// ============================================================ eventos
function bindEvents(): void {
  el.btnStart.addEventListener('click', onStart);
  el.btnPause.addEventListener('click', onPauseToggle);
  el.btnSkip.addEventListener('click', onSkip);
  el.btnReset.addEventListener('click', onReset);
  el.btnLoadVideo.addEventListener('click', loadVideoFromInput);
  el.videoUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadVideoFromInput();
  });

  el.studyInput.addEventListener('change', persistTimerSettings);
  el.breakInput.addEventListener('change', persistTimerSettings);
  el.cyclesInput.addEventListener('change', persistTimerSettings);

  document.querySelectorAll<HTMLButtonElement>('.step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.step;
      const dir = Number(btn.dataset.dir);
      const input = which === 'study' ? el.studyInput : which === 'break' ? el.breakInput : el.cyclesInput;
      const max = which === 'study' ? 180 : which === 'break' ? 60 : 20;
      input.value = String(clamp((Number(input.value) || 0) + dir, 1, max));
      persistTimerSettings();
    });
  });

  el.soundSelect.addEventListener('change', () => {
    settings.sound = el.soundSelect.value as SoundName;
    void window.pomo.setSettings({ sound: settings.sound });
  });
  el.volumeRange.addEventListener('input', () => {
    settings.volume = Number(el.volumeRange.value) / 100;
    void window.pomo.setSettings({ volume: settings.volume });
  });
  el.btnTestSound.addEventListener('click', () => playSound(settings.sound));

  el.btnPip.addEventListener('click', togglePip);

  el.btnTheme.addEventListener('click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    void window.pomo.setSettings({ theme: settings.theme });
  });

  el.btnMinimize.addEventListener('click', () => window.pomo.minimize());
  el.btnClose.addEventListener('click', () => window.pomo.close());

  // Comandos vindos do mini timer (PIP)
  window.pomo.onMiniControl?.((action) => {
    if (action === 'pause-toggle') {
      if (phase === 'IDLE') onStart();
      else onPauseToggle();
    } else if (action === 'reset') {
      onReset();
    }
  });

  // Mini fechado pela própria janelinha → desativa o botão 📌
  window.pomo.onMiniClosed?.(() => {
    settings.miniOpen = false;
    updatePipButton();
  });

  // Atalhos de teclado
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (phase === 'IDLE') onStart();
      else onPauseToggle();
    } else if (e.key.toLowerCase() === 'r') {
      onReset();
    } else if (e.key.toLowerCase() === 's') {
      onSkip();
    }
  });
}

// ============================================================ boot
async function boot(): Promise<void> {
  settings = { ...settings, ...(await window.pomo.getSettings()) };
  applyTheme();
  fillSettingsInputs();
  updatePipButton();
  renderStats();
  renderTimer();
  bindEvents();
  loadIframeApi();
  // se já havia vídeo salvo, carrega automaticamente (cued, sem autoplay)
  if (settings.videoUrl) {
    const parsed = parseYouTubeUrl(settings.videoUrl);
    if (parsed) createPlayer(parsed);
  }
}

void boot();
