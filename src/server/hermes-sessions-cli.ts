import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { resolveHermesBinary } from './hermes-agent'

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 8_000

function sanitizeSessionId(value: string): string {
  const id = value.trim()
  // Keep this strict: session ids in Hermes are UUIDs or timestamp-style.
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) {
    throw new Error('Invalid session id')
  }
  return id
}

function sanitizeTitle(value: string): string {
  const title = value.trim()
  if (!title) throw new Error('Title required')
  // Avoid extremely large arg payloads; Hermes also enforces its own limits.
  if (title.length > 200) throw new Error('Title too long')
  return title
}

function getHermesCliPath(): string {
  return process.env.HERMES_CLI_PATH?.trim() || resolveHermesBinary() || 'hermes'
}

async function runHermes(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const hermesPath = getHermesCliPath()
  const hermesAgentDir =
    process.env.HERMES_AGENT_PATH?.trim() ||
    `${process.env.HOME ?? homedir()}/.hermes/hermes-agent`
  try {
    console.log(`[hermes-cli] exec ${hermesPath} ${args.join(' ')} (cwd=${hermesAgentDir})`)
    const { stdout, stderr } = await execFileAsync(hermesPath, args, {
      timeout: DEFAULT_TIMEOUT_MS,
      cwd: hermesAgentDir ?? process.cwd(),
      // Ensure Hermes resolves ~/.hermes correctly under systemd.
      env: {
        ...process.env,
        HOME: process.env.HOME ?? '/home/lane-a',
        // Force the canonical Hermes home for the running services.
        // (Some shells export HERMES_HOME elsewhere; systemd usually doesn't.)
        HERMES_HOME:
          process.env.HERMES_HOME ??
          `${process.env.HOME ?? homedir()}/.hermes`,
      },
      maxBuffer: 1024 * 1024,
    })
    if (String(stderr ?? '').trim()) {
      console.warn('[hermes-cli] stderr', String(stderr).trim())
    }
    return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  } catch (err) {
    const e = err as Error & { stdout?: unknown; stderr?: unknown }
    const stdout = String(e.stdout ?? '')
    const stderr = String(e.stderr ?? '')
    const msg = e.message || 'Hermes CLI failed'
    console.error('[hermes-cli] failed', msg, stdout, stderr)
    throw new Error([msg, stdout, stderr].filter(Boolean).join('\n').trim())
  }
}

export async function renameSessionViaCli(sessionId: string, title: string): Promise<void> {
  const sid = sanitizeSessionId(sessionId)
  const t = sanitizeTitle(title)
  await runHermes(['sessions', 'rename', sid, t])
}

export async function deleteSessionViaCli(sessionId: string): Promise<void> {
  const sid = sanitizeSessionId(sessionId)
  await runHermes(['sessions', 'delete', sid, '--yes'])
}

