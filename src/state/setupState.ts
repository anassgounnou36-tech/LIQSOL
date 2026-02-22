import fs from 'node:fs';
import path from 'node:path';

const SETUP_STATE_PATH = path.join(process.cwd(), 'data', 'setup_state.json');
const BLOCKED_COOLDOWN_MS = 60_000;

interface BlockedState {
  reason: string;
  ts: number;
}

interface SetupState {
  blocked: Record<string, BlockedState>;
  atasCreated: Record<string, boolean>;
}

function defaultState(): SetupState {
  return { blocked: {}, atasCreated: {} };
}

function saveSetupState(state: SetupState): void {
  fs.mkdirSync(path.dirname(SETUP_STATE_PATH), { recursive: true });
  fs.writeFileSync(SETUP_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export function loadSetupState(): SetupState {
  if (!fs.existsSync(SETUP_STATE_PATH)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(SETUP_STATE_PATH, 'utf8')) as Partial<SetupState>;
    return {
      blocked: parsed.blocked ?? {},
      atasCreated: parsed.atasCreated ?? {},
    };
  } catch {
    return defaultState();
  }
}

export function markBlocked(planKey: string, reason: string): void {
  const state = loadSetupState();
  state.blocked[planKey] = { reason, ts: Date.now() };
  saveSetupState(state);
}

export function isBlocked(planKey: string): boolean {
  const blocked = loadSetupState().blocked[planKey];
  if (!blocked) return false;
  return (Date.now() - Number(blocked.ts ?? 0)) < BLOCKED_COOLDOWN_MS;
}

export function markAtaCreated(mint: string): void {
  const state = loadSetupState();
  state.atasCreated[mint] = true;
  saveSetupState(state);
}
