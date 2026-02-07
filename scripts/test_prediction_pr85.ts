import fs from 'fs';
import path from 'path';
import { scoreHazard } from '../src/predict/hazardScorer.js';
import { computeEV, EvParams } from '../src/predict/evCalculator.js';

interface CandidateData {
  key?: string;
  obligationPubkey?: string;
  healthRatio?: number;
  healthRatioRaw?: number;
  liquidationEligible?: boolean;
  borrowValueUsd?: number;
}

interface ScoredCandidate {
  key: string;
  healthRatio: number;
  hazard: number;
  ev: number;
  borrowValueUsd: number;
  liquidationEligible: boolean;
}

function loadCandidates(): CandidateData[] {
  const p = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(p)) {
    console.error('Missing data/candidates.json. Run: npm run snapshot:candidates:wsl');
    process.exit(1);
  }
  const raw = fs.readFileSync(p, 'utf8');
  try { 
    const parsed = JSON.parse(raw);
    // Handle both array and {candidates: array} formats
    return Array.isArray(parsed) ? parsed : (parsed.candidates || []);
  } catch (e) {
    console.error('Failed to parse candidates.json:', e);
    process.exit(1);
  }
}

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

const alpha = getEnvNum('HAZARD_ALPHA', 25);
const minBorrowUsd = getEnvNum('MIN_BORROW_USD', 10);
const params: EvParams = {
  closeFactor: getEnvNum('EV_CLOSE_FACTOR', 0.5),
  liquidationBonusPct: getEnvNum('EV_LIQUIDATION_BONUS_PCT', 0.05),
  flashloanFeePct: getEnvNum('EV_FLASHLOAN_FEE_PCT', 0.002),
  fixedGasUsd: getEnvNum('EV_FIXED_GAS_USD', 0.5),
  slippageBufferPct: process.env.EV_SLIPPAGE_BUFFER_PCT ? getEnvNum('EV_SLIPPAGE_BUFFER_PCT', 0.005) : undefined,
};

const data = loadCandidates();
const withScores: ScoredCandidate[] = data.map((c) => {
  const hr = Number(c.healthRatioRaw ?? c.healthRatio ?? 0);
  const hazard = scoreHazard(hr, alpha);
  const borrow = Number(c.borrowValueUsd ?? 0);
  const ev = computeEV(borrow, hazard, params);
  const liquidationEligible = c.liquidationEligible ?? false;
  return { 
    key: c.key ?? c.obligationPubkey ?? 'unknown', 
    healthRatio: hr, 
    hazard, 
    ev, 
    borrowValueUsd: borrow,
    liquidationEligible,
  };
}).filter((c) => c.liquidationEligible || c.borrowValueUsd >= minBorrowUsd);

withScores.sort((a, b) => b.ev - a.ev);

console.log('EV params:', params, 'hazard alpha:', alpha, 'minBorrowUsd:', minBorrowUsd);
console.table(withScores.slice(0, 10), ['key', 'healthRatio', 'hazard', 'ev', 'borrowValueUsd']);
