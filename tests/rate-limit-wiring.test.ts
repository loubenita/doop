import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The per-minute caps are configurable through environment variables. This
 * loads the MCP server fresh with MCP_UPLOADS_PER_MIN=2 and drives real
 * upload_asset calls, so a wrong env key or a missed call site would fail here
 * instead of quietly leaving the tool at its old default.
 */

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

/* add_font checks membership before the limiter: let the owner in, and keep the
   calls that pass the limiter off Google */
vi.mock('../server/fonts.ts', () => ({
  FontInputError: class FontInputError extends Error {},
  canUseScope: () => true,
  fontsForCanvas: () => [],
}))
const addGoogleFont = vi.fn(async () => [])
vi.mock('../server/googleFonts.ts', () => ({ addGoogleFont }))

const OWNER_ID = 'rate-limit-owner'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const { buildMcpServer } = await import('../server/mcp.ts')
  const { store } = await import('../server/store.ts')
  /* upload_asset resolves its canvas through canAccessCanvas, so the owner
     must actually own a canvas for the call to reach the limiter */
  const canvas = store.createCanvas('rate limits', OWNER_ID)
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-rate-limit-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, canvasId: canvas.id, close: () => server.close() }
}

async function upload(client: Client, canvasId: string) {
  const result = (await client.callTool({
    name: 'upload_asset',
    arguments: { local_file: true, canvas_id: canvasId, agent_name: 'Test' },
  })) as unknown as CallResult
  const raw = result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
  return { raw, isError: result.isError }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('configurable tool rate limits', () => {
  it('applies a lowered MCP_UPLOADS_PER_MIN to upload_asset', async () => {
    vi.stubEnv('MCP_UPLOADS_PER_MIN', '2')
    const { client, canvasId, close } = await connect()
    try {
      /* the first two tickets are handed out… */
      for (let i = 0; i < 2; i++) {
        const r = await upload(client, canvasId)
        expect(r.isError).toBeFalsy()
        expect(r.raw).toContain('upload_url')
      }
      /* …and the third hits the cap the env var set, not the built-in 15 */
      const limited = await upload(client, canvasId)
      expect(limited.isError).toBe(true)
      expect(limited.raw).toContain('rate limit')
    } finally {
      await close()
    }
  })

  it('applies a lowered MCP_ADD_FONTS_PER_MIN to add_font, before any font is fetched', async () => {
    vi.stubEnv('MCP_ADD_FONTS_PER_MIN', '2')
    addGoogleFont.mockClear()
    const { client, close } = await connect()
    try {
      const addFont = async () => {
        const result = (await client.callTool({
          name: 'add_font',
          arguments: { workspace_id: 'ws', family: 'Inter' },
        })) as unknown as CallResult
        return { raw: result.content.map((b) => b.text ?? '').join('\n'), isError: result.isError }
      }
      for (let i = 0; i < 2; i++) expect((await addFont()).isError).toBeFalsy()
      const limited = await addFont()
      expect(limited.isError).toBe(true)
      expect(limited.raw).toContain('add_font rate limit')
      expect(addGoogleFont).toHaveBeenCalledTimes(2)
    } finally {
      await close()
    }
  })
})
