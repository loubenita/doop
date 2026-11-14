import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

/* booted in a hook: starting PGlite takes seconds on a loaded machine, which the
   test's own 5s would have to cover; the migration it checks takes milliseconds */
const db = new PGlite()
beforeAll(() => db.waitReady)
afterAll(() => db.close())

it('excludes historical assets from billing while new uploads start eligible with no payer', async () => {
  await db.exec("CREATE TABLE assets (id text PRIMARY KEY); INSERT INTO assets VALUES ('old')")
  await db.exec(await readFile('server/db/migrations/0049_image_descriptions.sql', 'utf8'))
  await db.exec("INSERT INTO assets (id) VALUES ('new')")
  const result = await db.query(
    'SELECT id, describe_attempts, describe_payer_id, describe_provider FROM assets ORDER BY id',
  )
  expect(result.rows).toEqual([
    { id: 'new', describe_attempts: 0, describe_payer_id: null, describe_provider: null },
    { id: 'old', describe_attempts: 3, describe_payer_id: null, describe_provider: null },
  ])
})
