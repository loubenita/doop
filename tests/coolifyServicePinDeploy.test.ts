import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, swapPin } from '../scripts/coolify/service-pin-deploy.mjs'

const FROM = 'aa69c43414d81503744df573d5f65a4050584391'
const TO = 'e66e149f51788771983cf8e05e4f96e8b9108348'
const SERVICE = 'svc123'
const TOKEN = 'secret-token-never-printed'
const COMPOSE = `services:\n  doop:\n    image: 'ghcr.io/loubenita/doop:${FROM}'\n    environment:\n      - PORT=4400\n`

type Call = { method: string; url: string; body?: unknown; auth?: string }

/** A stand-in for Coolify's REST API and the app's health check: it records each call and answers like the real ones. */
function fakeCoolify(opts: { compose?: string; statuses?: string[]; readBack?: (sent: string) => string } = {}) {
  let stored = opts.compose ?? COMPOSE
  const statuses = [...(opts.statuses ?? ['restarting', 'running:healthy'])]
  const calls: Call[] = []
  const fetch = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body, auth: init.headers?.Authorization })
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
    if (url.endsWith('/healthz')) return json({ ok: true })
    if (method === 'GET' && url.endsWith(`/services/${SERVICE}`)) {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0]
      return json({ uuid: SERVICE, docker_compose_raw: stored, status })
    }
    if (method === 'PATCH') {
      const sent = Buffer.from(body.docker_compose_raw, 'base64').toString('utf8')
      stored = opts.readBack ? opts.readBack(sent) : sent
      return json({ uuid: SERVICE })
    }
    if (method === 'POST' && url.includes('/restart')) return json({ message: 'Service restaring request queued.' })
    return new Response('not found', { status: 404 })
  }
  return { fetch, calls, stored: () => stored }
}

let out: string
let logs: string[]

beforeEach(() => {
  out = mkdtempSync(path.join(tmpdir(), 'coolify-pin-'))
  logs = []
})
afterEach(() => rmSync(out, { recursive: true, force: true }))

function deps(fetch: unknown, env: Record<string, string | undefined> = { COOLIFY_TOKEN: TOKEN }) {
  return {
    env,
    fetch,
    log: (line: string) => logs.push(line),
    sleep: async () => {},
    now: () => Date.UTC(2026, 10, 24),
  }
}

const args = (...extra: string[]) => ['--service', SERVICE, '--from', FROM, '--to', TO, '--out', out, ...extra]

describe('swapPin', () => {
  it('swaps the old sha when it appears exactly once and reports the one changed line', () => {
    const { compose, diff } = swapPin(COMPOSE, FROM, TO)
    expect(compose).toBe(COMPOSE.replace(FROM, TO))
    expect(diff).toEqual({
      line: 3,
      before: `    image: 'ghcr.io/loubenita/doop:${FROM}'`,
      after: `    image: 'ghcr.io/loubenita/doop:${TO}'`,
    })
  })

  it.each([
    ['is missing', COMPOSE.replace(FROM, 'something-else'), /found 0 times/],
    ['appears twice', `${COMPOSE}  # pinned at ${FROM}\n`, /found 2 times/],
  ])('refuses when the old sha %s', (_case, compose, message) => {
    expect(() => swapPin(compose, FROM, TO)).toThrow(message)
  })
})

describe('service-pin-deploy', () => {
  it('defaults to a dry run: only the GET, the saved rollback file and the diff', async () => {
    const coolify = fakeCoolify()
    expect(await run(args(), deps(coolify.fetch))).toBe(0)
    expect(coolify.calls.map((c) => c.method)).toEqual(['GET'])
    expect(coolify.calls[0]).toMatchObject({
      url: `https://admin.loubenita.com/api/v1/services/${SERVICE}`,
      auth: `Bearer ${TOKEN}`,
    })
    const [saved = ''] = readdirSync(out)
    expect(saved).toMatch(/\.compose\.yml$/)
    expect(readFileSync(path.join(out, saved), 'utf8')).toBe(COMPOSE)
    const text = logs.join('\n')
    expect(text).toContain(path.join(out, saved))
    expect(text).toContain(`- line 3:     image: 'ghcr.io/loubenita/doop:${FROM}'`)
    expect(text).toContain(`+ line 3:     image: 'ghcr.io/loubenita/doop:${TO}'`)
    expect(text).toContain('dry run')
    expect(coolify.stored()).toBe(COMPOSE)
  })

  it('changes nothing when the old sha is not there exactly once', async () => {
    const coolify = fakeCoolify({ compose: `${COMPOSE}# ${FROM}\n` })
    expect(await run(args('--apply'), deps(coolify.fetch))).toBe(1)
    expect(coolify.calls.map((c) => c.method)).toEqual(['GET'])
    expect(logs.join('\n')).toMatch(/found 2 times/)
  })

  it('applies: sends the new compose base64-encoded, reads it back, restarts with a fresh pull, waits for healthy, checks /healthz', async () => {
    const coolify = fakeCoolify()
    expect(await run(args('--apply'), deps(coolify.fetch))).toBe(0)
    const patch = coolify.calls.find((c) => c.method === 'PATCH')!
    expect(Buffer.from((patch.body as { docker_compose_raw: string }).docker_compose_raw, 'base64').toString()).toBe(
      COMPOSE.replace(FROM, TO),
    )
    expect(coolify.calls.find((c) => c.method === 'POST')!.url).toBe(
      `https://admin.loubenita.com/api/v1/services/${SERVICE}/restart?latest=true`,
    )
    expect(coolify.calls.at(-1)!.url).toBe('https://doop.loubenita.com/healthz')
    expect(coolify.stored()).toBe(COMPOSE.replace(FROM, TO))
    expect(logs.join('\n')).toContain('running:healthy')
  })

  it('stops before restarting when the read-back compose is not what was sent', async () => {
    const coolify = fakeCoolify({ readBack: () => COMPOSE })
    expect(await run(args('--apply'), deps(coolify.fetch))).toBe(1)
    expect(coolify.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(logs.join('\n')).toMatch(/read back/)
  })

  it('fails with the rollback command when the service is not healthy in time', async () => {
    const coolify = fakeCoolify({ statuses: ['exited:unhealthy'] })
    let clock = 0
    const slow = { ...deps(coolify.fetch), now: () => (clock += 60_000) }
    expect(await run(args('--apply', '--timeout', '300'), slow)).toBe(1)
    const text = logs.join('\n')
    expect(text).toMatch(/exited:unhealthy/)
    expect(text).toContain('--rollback')
  })

  it('--rollback restores a saved compose and restarts', async () => {
    const coolify = fakeCoolify({ compose: COMPOSE.replace(FROM, TO) })
    const file = path.join(out, 'saved.yml')
    writeFileSync(file, COMPOSE)
    expect(await run(['--service', SERVICE, '--rollback', file, '--apply'], deps(coolify.fetch))).toBe(0)
    expect(coolify.stored()).toBe(COMPOSE)
    expect(coolify.calls.some((c) => c.method === 'POST' && c.url.endsWith('/restart?latest=true'))).toBe(true)
  })

  it('needs COOLIFY_TOKEN and never prints it', async () => {
    const coolify = fakeCoolify()
    expect(await run(args(), deps(coolify.fetch, {}))).toBe(64)
    expect(coolify.calls).toEqual([])
    await run(args('--apply'), deps(coolify.fetch))
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
})
