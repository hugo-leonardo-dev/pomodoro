/**
 * Mini timer (PIP) — recebe estado por IPC e renderiza.
 * O contador roda por timestamp (endAt) — não dessincroniza.
 */

type MiniState = {
  phase: string; // IDLE | STUDYING | PAUSED_STUDY | BREAK | PAUSED_BREAK | DONE
  endAt: number; // 0 se não aplicável
  remainingMs: number;
  currentCycle: number;
  totalCycles: number;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  miniCard: $('miniCard'),
  mode: $('mode'),
  time: $('time'),
  cycle: $('cycle'),
  btnPlay: $('btnPlay') as HTMLButtonElement,
  btnExpand: $('btnExpand'),
  btnClose: $('btnClose'),
};

let state: MiniState = {
  phase: 'IDLE',
  endAt: 0,
  remainingMs: 0,
  currentCycle: 1,
  totalCycles: 4,
};

let tickHandle: number | null = null;

const fmt = (ms: number): string => {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

function render(): void {
  const p = state.phase;
  const running = p === 'STUDYING' || p === 'BREAK';
  const paused = p === 'PAUSED_STUDY' || p === 'PAUSED_BREAK';

  let ms: number;
  let cls: string;
  if (running) {
    ms = state.endAt - Date.now();
    cls = p === 'STUDYING' ? 'study' : 'break';
  } else if (paused) {
    ms = state.remainingMs;
    cls = 'paused';
  } else {
    ms = 0;
    cls = 'idle';
  }

  el.time.textContent = running || paused ? fmt(ms) : '—';
  el.time.className = `time ${cls}`;
  el.miniCard.className = `mini ${cls === 'study' || cls === 'break' ? cls : ''}`;

  const labels: Record<string, string> = {
    IDLE: 'READY',
    STUDYING: 'STUDY',
    PAUSED_STUDY: 'STUDY · PAUSED',
    BREAK: 'BREAK',
    PAUSED_BREAK: 'BREAK · PAUSED',
    DONE: 'DONE',
  };
  el.mode.textContent = labels[p] ?? p;

  el.cycle.textContent =
    p === 'IDLE' || p === 'DONE'
      ? `Cycles: ${state.totalCycles}`
      : `Session: ${state.currentCycle}/${state.totalCycles}`;

  el.btnPlay.classList.toggle('is-paused', paused);

  if (running && tickHandle === null) {
    tickHandle = window.setInterval(() => {
      el.time.textContent = fmt(state.endAt - Date.now());
    }, 500);
  } else if (!running && tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

window.pomo.miniOnState((s: MiniState) => {
  state = s;
  render();
});

el.btnPlay.addEventListener('click', () => window.pomo.miniControl('pause-toggle'));
el.btnExpand.addEventListener('click', () => window.pomo.miniControl('show-main'));
el.btnClose.addEventListener('click', () => window.pomo.miniControl('close'));

render();
