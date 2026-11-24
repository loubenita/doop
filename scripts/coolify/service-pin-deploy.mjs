#!/usr/bin/env node
/**
 * Moves a Coolify service (a docker-compose resource, not a Coolify application) from one pinned commit to another.
 *
 * The production Doop runs as a Coolify service whose compose file names the commit it runs. Deploying a newer commit
 * means swapping that sha in the compose, saving it, and restarting the service with a fresh pull. This does that, and
 * keeps the compose it found so a bad deploy can be put back with --rollback.
 *
 *   node scripts/coolify/service-pin-deploy.mjs --service <uuid> --from <sha> --to <sha> [--apply]
 *   node scripts/coolify/service-pin-deploy.mjs --service <uuid> --rollback <file> [--apply]
 *
 * Without --apply (or with --dry-run) it only reads the service, saves its compose and prints the change it would make.
 * COOLIFY_TOKEN (an API token) comes from the environment and is never printed. COOLIFY_URL overrides the API base.
 * Other flags: --out <dir> for the saved compose (default ~/.coolify-runs), --health <url> for the app's health check,
 * --timeout <seconds> to wait for running:healthy (default 600).
 * API: https://coolify.io/docs/api-reference (PATCH takes docker_compose_raw base64-encoded; restart is a POST whose
 * latest=true pulls the newest images).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_API = 'https://admin.loubenita.com/api/v1'
const DEFAULT_HEALTH = 'https://doop.loubenita.com/healthz'
const HEALTHY = 'running:healthy'
const POLL_MS = 5_000
const USAGE =
  'usage: service-pin-deploy.mjs --service <uuid> (--from <sha> --to <sha> | --rollback <file>) [--apply|--dry-run] [--out <dir>] [--health <url>] [--timeout <s>]'

/**
 * Replaces `from` with `to` in a compose file, refusing unless `from` appears exactly once.
 * @param {string} compose
 * @param {string} from
 * @param {string} to
 * @returns {{ compose: string, diff: { line: number, before: string, after: string } }}
 */
export function swapPin(compose, from, to) {
  const found = compose.split(from).length - 1
  if (found !== 1) throw new Error(`the old sha ${from} must appear exactly once in the compose; found ${found} times`)
  const lines = compose.split('\n')
  const index = lines.findIndex((line) => line.includes(from))
  const before = lines[index]
  const after = before.replace(from, to)
  lines[index] = after
  return { compose: lines.join('\n'), diff: { line: index + 1, before, after } }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '')
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      i++
    } else flags[name] = true
  }
  return flags
}

/**
 * Runs the deploy. Every side effect comes in through `deps`, so a test can stand in for Coolify.
 * @param {string[]} argv
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch, log: (line: string) => void,
 *   sleep: (ms: number) => Promise<void>, now: () => number }} deps
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, deps) {
  const { env, log } = deps
  const flags = parseArgs(argv)
  const service = flags.service
  const rollback = typeof flags.rollback === 'string' ? flags.rollback : undefined
  const swapping = typeof flags.from === 'string' && typeof flags.to === 'string'
  if (typeof service !== 'string' || (!rollback && !swapping)) {
    log(USAGE)
    return 64
  }
  const token = env.COOLIFY_TOKEN
  if (!token) {
    log('COOLIFY_TOKEN is not set')
    return 64
  }
  const apply = flags.apply === true && flags['dry-run'] !== true
  const api = `${(env.COOLIFY_URL ?? DEFAULT_API).replace(/\/$/, '')}/services/${service}`
  const health = typeof flags.health === 'string' ? flags.health : DEFAULT_HEALTH
  const timeoutMs = (Number(flags.timeout) || 600) * 1000
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }

  /** @param {string} url @param {RequestInit} [init] */
  const call = async (url, init) => {
    const response = await deps.fetch(url, { ...init, headers })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`${init?.method ?? 'GET'} ${url} answered ${response.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : {}
  }

  try {
    const current = await call(api)
    const found = String(current.docker_compose_raw ?? '')
    if (!found) throw new Error('the service has no docker_compose_raw')
    const outDir = typeof flags.out === 'string' ? flags.out : path.join(homedir(), '.coolify-runs')
    mkdirSync(outDir, { recursive: true })
    const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-')
    const saved = path.join(outDir, `${service}-${stamp}.compose.yml`)
    writeFileSync(saved, found)
    log(`saved the current compose for rollback: ${saved}`)
    log(`service status now: ${current.status ?? 'unknown'}`)

    let next
    if (rollback) {
      next = readFileSync(rollback, 'utf8')
      log(`restoring the compose saved in ${rollback}`)
    } else {
      const swap = swapPin(found, /** @type {string} */ (flags.from), /** @type {string} */ (flags.to))
      next = swap.compose
      log(`- line ${swap.diff.line}: ${swap.diff.before}`)
      log(`+ line ${swap.diff.line}: ${swap.diff.after}`)
    }
    if (!apply) {
      log('dry run: nothing changed. Run again with --apply to save the compose and restart the service.')
      return 0
    }

    await call(api, {
      method: 'PATCH',
      body: JSON.stringify({ docker_compose_raw: Buffer.from(next, 'utf8').toString('base64') }),
    })
    const readBack = String((await call(api)).docker_compose_raw ?? '')
    if (readBack !== next)
      throw new Error(`the compose read back is not the one sent; put it back with --rollback ${saved}`)
    log('compose saved and read back unchanged')

    const restart = await call(`${api}/restart?latest=true`, { method: 'POST' })
    log(`restart: ${restart.message ?? 'queued'}`)

    const deadline = deps.now() + timeoutMs
    let status = 'unknown'
    for (;;) {
      status = String((await call(api)).status ?? 'unknown')
      log(`status: ${status}`)
      if (status === HEALTHY) break
      if (deps.now() >= deadline) {
        log(`not ${HEALTHY} within ${timeoutMs / 1000}s (last: ${status}). To put the old compose back:`)
        log(`  node scripts/coolify/service-pin-deploy.mjs --service ${service} --rollback ${saved} --apply`)
        return 1
      }
      await deps.sleep(POLL_MS)
    }

    const check = await deps.fetch(health)
    const body = (await check.text()).slice(0, 200)
    log(`${health}: ${check.status} ${body}`)
    return check.ok ? 0 : 1
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const code = await run(process.argv.slice(2), {
    env: process.env,
    fetch,
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  })
  process.exit(code)
}
