import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/* Without BUCKET, server/storage.ts writes uploads to /app/data/assets inside the
   container while their rows go to Postgres. A self-host compose that mounts no
   volume there loses every uploaded picture and font on the next container
   recreate, and the surviving rows answer /a/<id> with 404 (MSTUD-1246). */
const compose = readFileSync(path.join(import.meta.dirname, '..', 'docker-compose.yml'), 'utf8')

function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`)
  expect(start, `service ${name} in docker-compose.yml`).toBeGreaterThan(-1)
  const rest = compose.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}\S|\n\S/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe('docker-compose.yml', () => {
  it('keeps the app data directory on a named volume, so uploads outlive the container', () => {
    const mount = serviceBlock('doop').match(/^\s+- ([\w-]+):\/app\/data\s*$/m)
    expect(mount, 'a named volume mounted at /app/data on the doop service').not.toBeNull()
    expect(compose).toMatch(new RegExp(`^volumes:\\n(?: {2}[\\w-]+:\\n)*? {2}${mount?.[1]}:`, 'm'))
  })
})
