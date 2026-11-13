import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import { addFont, hydrateFonts, listFonts } from '../server/fonts.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { createWorkspace } from '../server/workspaces.ts'
import { MAX_FONT_BYTES } from '../shared/fonts.ts'
import { ttf } from './fontFiles.ts'

/**
 * The add_font MCP tool: a Google Fonts family goes into a workspace's font
 * library through the same addFont an upload uses. Google is the only edge
 * stubbed (fetch); the CSS below is the real response of
 * https://fonts.googleapis.com/css2?family=Inter:wght@400;700 (and its
 * ital,wght twin), requested without a browser User-Agent, which is what
 * makes Google answer with one whole TTF per face.
 */

/* the suite calls the tool far more often than a minute's cap; the cap itself is tested in rate-limit-wiring */
vi.hoisted(() => {
  process.env.MCP_ADD_FONTS_PER_MIN = '1000'
})

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})
vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))
/* the object store is the other edge: keep the bytes in memory, not under ./data */
const stored = new Map<string, Buffer>()
vi.mock('../server/storage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/storage.ts')>()),
  putObject: async (key: string, body: Buffer) => void stored.set(key, body),
}))

const GSTATIC = 'https://fonts.gstatic.com/s/inter/v20'
const face = (style: string, weight: number, file: string, host = 'https://fonts.gstatic.com') =>
  `@font-face {\n  font-family: 'Inter';\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(${host}/s/inter/v20/${file}.ttf) format('truetype');\n}\n`
const NORMAL_400 = face('normal', 400, 'UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg')
const NORMAL_700 = face('normal', 700, 'UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYMZg')
const ITALIC_400 = face('italic', 400, 'UcCM3FwrK3iLTcvneQg7Ca725JhhKnNqk4j1ebLhAm8SrXTc2dthjQ')
const REAL_CSS = {
  'Inter:wght@400': NORMAL_400,
  'Inter:wght@400;700': NORMAL_400 + NORMAL_700,
  'Inter:ital,wght@0,400;1,400': ITALIC_400 + NORMAL_400,
}
const FONT_FILES: Record<string, Buffer> = {
  [`${GSTATIC}/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf`]: ttf({ family: 'Inter', weight: 400 }),
  [`${GSTATIC}/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYMZg.ttf`]: ttf({ family: 'Inter', weight: 700 }),
  [`${GSTATIC}/UcCM3FwrK3iLTcvneQg7Ca725JhhKnNqk4j1ebLhAm8SrXTc2dthjQ.ttf`]: ttf({
    family: 'Inter',
    weight: 400,
    italic: true,
  }),
}

let requested: string[]
let cssOverride: Record<string, string>

/** A gstatic file URL that answers with a redirect to another host. */
const MOVED = `${GSTATIC}/moved.ttf`

/** A gstatic file that is no font, and one that announces more bytes than a font may hold. */
const NOT_A_FONT = `${GSTATIC}/notafont.ttf`
const HUGE = `${GSTATIC}/huge.ttf`

/** Without a browser-like User-Agent Google answers whole TTFs; the tool must say so itself. */
const USER_AGENT = 'doop-font-fetch'

/** Google as the tool sees it: CSS for known families, a 400 for the rest. */
function google(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input)
  requested.push(url)
  if (new Headers(init?.headers).get('user-agent') !== USER_AGENT)
    return Promise.resolve(new Response('browser-like request', { status: 403 }))
  if (url === NOT_A_FONT) return Promise.resolve(new Response('this is not a font file at all'))
  if (url === HUGE)
    return Promise.resolve(new Response('tiny', { headers: { 'content-length': String(MAX_FONT_BYTES + 1) } }))
  if (url === MOVED) {
    /* what fetch does with a 302: refuse under redirect 'error', else follow it */
    if (init?.redirect === 'error') return Promise.reject(new TypeError('fetch failed: unexpected redirect'))
    requested.push('https://evil.example/font.ttf')
    return Promise.resolve(new Response(new Uint8Array(ttf({ family: 'Inter', weight: 400 }))))
  }
  if (url.startsWith('https://fonts.googleapis.com/css2?family=')) {
    const query = decodeURIComponent(url.slice('https://fonts.googleapis.com/css2?family='.length)).replace(/\+/g, ' ')
    const css = { ...REAL_CSS, ...cssOverride }[query]
    return Promise.resolve(
      css ? new Response(css, { status: 200 }) : new Response('<html>family not found</html>', { status: 400 }),
    )
  }
  const bytes = FONT_FILES[url]
  return Promise.resolve(bytes ? new Response(new Uint8Array(bytes)) : new Response('no', { status: 404 }))
}

let workspaceId: string
let otherWorkspaceId: string

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
  workspaceId = createWorkspace('Brand Co', 'member-id').id
  otherWorkspaceId = createWorkspace('Elsewhere', 'someone-else').id
}, 30_000)

beforeEach(async () => {
  requested = []
  cssOverride = {}
  stored.clear()
  vi.stubGlobal('fetch', vi.fn(google))
  await db.delete((await import('../server/db/schema.ts')).fonts)
  await hydrateFonts()
})

async function addFontAs(userId: string, args: Record<string, unknown>) {
  const server = buildMcpServer('Member', userId)
  const client = new Client({ name: 'add-font-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    const result = (await client.callTool({ name: 'add_font', arguments: args })) as {
      isError?: boolean
      content: { type: string; text?: string }[]
    }
    return { isError: result.isError === true, text: result.content.map((c) => c.text ?? '').join('\n') }
  } finally {
    await client.close()
    await server.close()
  }
}

const library = () => listFonts({ workspaceId }, 'member-id')
const faces = (rows: { family: string; weight: string; style: string }[]) =>
  rows.map(({ family, weight, style }) => ({ family, weight, style }))

describe('add_font', () => {
  it('adds each weight of a Google family to the workspace library and lists the rows', async () => {
    const { isError, text } = await addFontAs('member-id', {
      workspace_id: workspaceId,
      family: 'Inter',
      weights: [400, 700],
    })

    expect(isError).toBe(false)
    const expected = [
      { family: 'Inter', weight: '400', style: 'normal' },
      { family: 'Inter', weight: '700', style: 'normal' },
    ]
    expect(faces(library())).toEqual(expected)
    expect(JSON.parse(text).fonts).toEqual(expected)
    expect(stored.size).toBe(2)
    /* the axes name exactly the weights asked for, so Google answers one TTF each */
    expect(requested[0]).toBe('https://fonts.googleapis.com/css2?family=Inter:wght@400;700')
  })

  it('asks for the regular weight when none is named', async () => {
    await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(requested[0]).toBe('https://fonts.googleapis.com/css2?family=Inter:wght@400')
    expect(faces(library())).toEqual([{ family: 'Inter', weight: '400', style: 'normal' }])
  })

  it('adds the italic faces too when italic is set', async () => {
    await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter', weights: [400], italic: true })

    expect(requested[0]).toBe('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;1,400')
    expect(
      faces(library())
        .map((f) => f.style)
        .sort(),
    ).toEqual(['italic', 'normal'])
  })

  it('refuses someone outside the workspace and stores nothing', async () => {
    const stranger = await addFontAs('stranger-id', { workspace_id: workspaceId, family: 'Inter' })
    const wrongWorkspace = await addFontAs('member-id', { workspace_id: otherWorkspaceId, family: 'Inter' })

    expect(stranger).toMatchObject({ isError: true, text: expect.stringContaining('no workspace with id') })
    expect(wrongWorkspace).toMatchObject({ isError: true, text: expect.stringContaining('no workspace with id') })
    expect(requested).toEqual([])
    expect(stored.size).toBe(0)
    expect(library()).toEqual([])
  })

  it('refuses a family Google does not serve, such as SF Pro, and stores nothing', async () => {
    const { isError, text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'SF Pro' })

    expect(isError).toBe(true)
    expect(text).toContain('Google Fonts')
    expect(text).toContain('SF Pro')
    expect(library()).toEqual([])
  })

  it('refuses a font file URL on any host but fonts.gstatic.com, fetching nothing from it', async () => {
    cssOverride['Inter:wght@400'] = face('normal', 400, 'evil', 'https://evil.example')

    const { isError, text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(isError).toBe(true)
    expect(text).toContain('evil.example')
    expect(requested.some((url) => url.includes('evil.example'))).toBe(false)
    expect(library()).toEqual([])
  })

  it('refuses a plain-http font file URL on the right host', async () => {
    cssOverride['Inter:wght@400'] = NORMAL_400.replace('https://', 'http://')

    const { isError, text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(isError).toBe(true)
    expect(text).toContain('fonts.gstatic.com')
    expect(library()).toEqual([])
  })

  it('refuses a font file that redirects, following it nowhere', async () => {
    cssOverride['Inter:wght@400'] = face('normal', 400, 'moved')

    const { isError } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(isError).toBe(true)
    expect(requested.some((url) => url.includes('evil.example'))).toBe(false)
    expect(library()).toEqual([])
  })

  it('stores nothing when any one font file fails to download', async () => {
    /* the first file downloads; the second is missing on Google */
    cssOverride['Inter:wght@400;700'] = NORMAL_400 + face('normal', 700, 'missing')

    const { isError } = await addFontAs('member-id', {
      workspace_id: workspaceId,
      family: 'Inter',
      weights: [400, 700],
    })

    expect(isError).toBe(true)
    expect(stored.size).toBe(0)
    expect(library()).toEqual([])
  })

  it("returns only the added family's rows, not the rest of the library", async () => {
    await addFont({ workspaceId }, { id: 'member-id', name: 'Member' }, ttf({ family: 'Roboto', weight: 400 }), 'r.ttf')

    const { text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(JSON.parse(text).fonts).toEqual([{ family: 'Inter', weight: '400', style: 'normal' }])
    expect(library()).toHaveLength(2)
  })

  it('refuses a family name that could change the request, asking Google nothing', async () => {
    const { isError } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter:wght@900&x=1' })

    expect(isError).toBe(true)
    expect(requested).toEqual([])
  })

  it('downloads a font file the stylesheet names twice only once', async () => {
    cssOverride['Inter:wght@400'] = NORMAL_400 + NORMAL_400

    await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(requested.filter((url) => url.startsWith(GSTATIC))).toHaveLength(1)
    expect(library()).toHaveLength(1)
  })

  it('replaces a face that is added again instead of duplicating it', async () => {
    await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter', weights: [400, 700] })
    const first = library().map((f) => f.id)
    const { text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter', weights: [400] })

    const rows = library()
    expect(faces(rows)).toEqual([
      { family: 'Inter', weight: '400', style: 'normal' },
      { family: 'Inter', weight: '700', style: 'normal' },
    ])
    expect(rows.find((f) => f.weight === '400')!.id).not.toBe(first[0])
    expect(rows.find((f) => f.weight === '700')!.id).toBe(first[1])
    expect(JSON.parse(text).fonts).toHaveLength(2)
  })

  it('stores nothing, and names the face, when a later file downloads but is not a font', async () => {
    cssOverride['Inter:wght@400;700'] = NORMAL_400 + face('normal', 700, 'notafont')

    const { isError, text } = await addFontAs('member-id', {
      workspace_id: workspaceId,
      family: 'Inter',
      weights: [400, 700],
    })

    expect(isError).toBe(true)
    expect(text).toContain('notafont.ttf')
    expect(text).toContain('not a font file')
    expect(stored.size).toBe(0)
    expect(library()).toEqual([])
  })

  it('refuses a weight Google would round to another, fetching nothing', async () => {
    const { isError } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter', weights: [450] })

    expect(isError).toBe(true)
    expect(requested).toEqual([])
  })

  it('refuses a stylesheet naming more than 18 font files, fetching none of them', async () => {
    cssOverride['Inter:wght@400'] = Array.from({ length: 19 }, (_, i) => face('normal', 400, `f${i}`)).join('')

    const { isError, text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(isError).toBe(true)
    expect(text).toContain('19')
    expect(requested.filter((url) => url.startsWith(GSTATIC))).toEqual([])
    expect(library()).toEqual([])
  })

  it('refuses a font file whose content-length is over the limit, without reading it', async () => {
    cssOverride['Inter:wght@400'] = face('normal', 400, 'huge')

    const { isError, text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(isError).toBe(true)
    expect(text).toContain('10 MB')
    expect(stored.size).toBe(0)
  })

  it('tells a 400 from Google may be a wrong-case family name', async () => {
    const { isError, text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'inter' })

    expect(isError).toBe(true)
    expect(text).toContain('case-sensitive')
    expect(text).toContain('"Inter"')
  })

  it('does not repeat unparsable stylesheet text back to the agent', async () => {
    cssOverride['Inter:wght@400'] = "@font-face { src: url(secret-from-the-stylesheet) format('truetype'); }"

    const { isError, text } = await addFontAs('member-id', { workspace_id: workspaceId, family: 'Inter' })

    expect(isError).toBe(true)
    expect(text).not.toContain('secret-from-the-stylesheet')
  })
})
