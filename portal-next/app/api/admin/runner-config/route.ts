import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const execAsync = promisify(exec);

const SHARDS_FILE   = '/data/init-data/runner-shards.txt';
const SHARDS_ROOT   = '/data/runner-shards';
const RUNNER_TOKEN  = '/data/init-data/runner-token.txt';
const PORTAL_TOKEN  = '/data/init-data/portal-token.txt';

interface RunnerReg {
  name?: string;
  id?: number;
  labels?: string[];
  address?: string;
}

function readShards(): number {
  if (existsSync(SHARDS_FILE)) {
    const n = parseInt(readFileSync(SHARDS_FILE, 'utf-8').trim(), 10);
    if (n >= 1 && n <= 8) return n;
  }
  const env = parseInt(process.env.RUNNER_SHARDS ?? '4', 10);
  return env >= 1 && env <= 8 ? env : 4;
}

function readRegisteredRunners(): RunnerReg[] {
  const runners: RunnerReg[] = [];
  if (!existsSync(SHARDS_ROOT)) return runners;
  for (const entry of readdirSync(SHARDS_ROOT).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const regFile = `${SHARDS_ROOT}/${entry}/.runner`;
    if (!existsSync(regFile)) continue;
    try {
      const reg = JSON.parse(readFileSync(regFile, 'utf-8')) as RunnerReg;
      runners.push(reg);
    } catch { /* skip corrupt */ }
  }
  return runners;
}

async function applyShards(n: number): Promise<string> {
  const tokenVal = existsSync(RUNNER_TOKEN)
    ? readFileSync(RUNNER_TOKEN, 'utf-8').trim()
    : '';
  const giteaToken = existsSync(PORTAL_TOKEN)
    ? readFileSync(PORTAL_TOKEN, 'utf-8').trim()
    : '';
  const env = [
    `RUNNER_SHARDS=${n}`,
    tokenVal ? `RUNNER_TOKEN_VAL=${tokenVal}` : '',
    giteaToken ? `GITEA_TOKEN=${giteaToken}` : '',
    'REGISTER=1',
  ].filter(Boolean).join(' ');

  const { stdout, stderr } = await execAsync(`${env} /usr/local/bin/setup-runner-shards.sh`);
  await execAsync('supervisorctl reread 2>/dev/null || true').catch(() => {});
  const { stdout: updateOut } = await execAsync('supervisorctl update 2>/dev/null || true').catch(() => ({ stdout: '' }));
  return (stdout + stderr + updateOut).trim();
}

async function auth(req: NextRequest) {
  const session = await getSession();
  if (!session.user) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  if (!isPlatformAdmin(session.user)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return null;
}

export async function GET(req: NextRequest) {
  const deny = await auth(req);
  if (deny) return deny;

  const runners = readRegisteredRunners();
  const shards  = readShards();
  const mode    = process.env.RUNNER_MODE === 'docker' ? 'docker' : 'sharded-host';

  return NextResponse.json({
    mode,
    shards,
    registered: runners.length > 0,
    registeredRunners: runners.map(r => ({
      name:    r.name    ?? null,
      id:      r.id      ?? null,
      labels:  r.labels  ?? [],
      address: r.address ?? null,
    })),
    // Legacy fields for backward compatibility
    name:     runners[0]?.name ?? null,
    id:       runners[0]?.id   ?? null,
    labels:   runners[0]?.labels ?? [],
    address:  runners[0]?.address ?? null,
    capacity: shards,
  });
}

export async function PUT(req: NextRequest) {
  const deny = await auth(req);
  if (deny) return deny;

  const body = await req.json() as { shards?: number; capacity?: number };
  const n    = body.shards ?? body.capacity;

  if (typeof n !== 'number' || n < 1 || n > 8) {
    return NextResponse.json({ error: 'shards must be 1–8' }, { status: 400 });
  }

  try {
    const restartOut = await applyShards(n);
    return NextResponse.json({ ok: true, shards: n, mode: 'sharded-host', restartOutput: restartOut });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to apply shard count' },
      { status: 500 },
    );
  }
}
