import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { addMember, createWorkspace, getWorkspace } from '../server/workspaces.ts'

/**
 * The workspace MCP tools: list, create, rename, delete, and moving a whole
 * canvas between workspaces. Each one applies the web app's rules for the
 * connected account: a non-member is told the workspace is not there, a
 * member may not rename, only the owner deletes, and only the canvas owner
 * files a canvas into a workspace. Real store and database (PGlite).
 */

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})
vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
}, 30_000)

async function callAs(userId: string, name: string, args: Record<string, unknown> = {}) {
  const server = buildMcpServer('Someone', userId)
  const client = new Client({ name: 'workspace-tools-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: { type: string; text?: string }[]
    }
    const text = result.content.map((c) => c.text ?? '').join('\n')
    return { isError: result.isError === true, text }
  } finally {
    await client.close()
    await server.close()
  }
}

const json = (reply: { text: string }) => JSON.parse(reply.text)

/** A workspace owned by `owner`, with `admin` and `member` in it. */
function team(name: string) {
  const ws = createWorkspace(name, 'owner-id')
  addMember(ws.id, 'admin-id', 'admin', 'owner-id')
  addMember(ws.id, 'member-id', 'member', 'owner-id')
  return ws
}

/** A canvas holding two frames, so a move can be checked against them. */
function canvasWithFrames(ownerId: string, workspaceId?: string) {
  const canvas = store.createCanvas('Concepts', ownerId, workspaceId)
  store.createFrame(canvas.id, { name: 'Home', html: '<h1>Home</h1>' }, 'tester')
  store.createFrame(canvas.id, { name: 'Vault', html: '<h1>Vault</h1>' }, 'tester')
  return canvas
}

const frameSnapshot = (canvasId: string) =>
  store.getCanvas(canvasId)!.frames.map(({ id, name, html, x, y, width, height, pageId, updatedAt }) => ({
    id,
    name,
    html,
    x,
    y,
    width,
    height,
    pageId,
    updatedAt,
  }))

describe('list_workspaces', () => {
  it("lists the account's workspaces with its role and canvas count, and nobody else's", async () => {
    const mine = team('Listed Co')
    const theirs = createWorkspace('Not Mine', 'stranger-id')
    store.createCanvas('In it', 'owner-id', mine.id)

    const reply = await callAs('member-id', 'list_workspaces')

    expect(reply.isError).toBe(false)
    const rows = json(reply).workspaces as { id: string; name: string; role: string; canvas_count: number }[]
    expect(rows.find((w) => w.id === mine.id)).toMatchObject({ name: 'Listed Co', role: 'member', canvas_count: 1 })
    expect(rows.some((w) => w.id === theirs.id)).toBe(false)
  })
})

describe('create_workspace', () => {
  it('creates a workspace the account owns and returns its id', async () => {
    const reply = await callAs('creator-id', 'create_workspace', { name: '  HomeVault  ' })

    expect(reply.isError).toBe(false)
    const created = json(reply)
    expect(created).toMatchObject({ name: 'HomeVault', role: 'owner' })
    expect(getWorkspace(created.id)).toMatchObject({ name: 'HomeVault', ownerId: 'creator-id' })
  })

  it('refuses a blank name', async () => {
    const reply = await callAs('creator-id', 'create_workspace', { name: '   ' })

    expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('name') })
  })
})

describe('rename_workspace', () => {
  it('lets an admin rename, refuses a plain member, and hides the workspace from a stranger', async () => {
    const ws = team('Old Name')

    const renamed = await callAs('admin-id', 'rename_workspace', { workspace_id: ws.id, name: 'New Name' })
    const byMember = await callAs('member-id', 'rename_workspace', { workspace_id: ws.id, name: 'Member Name' })
    const byStranger = await callAs('stranger-id', 'rename_workspace', { workspace_id: ws.id, name: 'Mine' })

    expect(renamed.isError).toBe(false)
    expect(json(renamed)).toMatchObject({ id: ws.id, name: 'New Name' })
    expect(byMember).toMatchObject({ isError: true, text: expect.stringContaining('admins') })
    expect(byStranger).toMatchObject({ isError: true, text: expect.stringContaining(`no workspace with id ${ws.id}`) })
    expect(getWorkspace(ws.id)?.name).toBe('New Name')
  })
})

describe('delete_workspace', () => {
  it('refuses without confirm=true and leaves the workspace in place', async () => {
    const ws = team('Keep Me')

    const reply = await callAs('owner-id', 'delete_workspace', { workspace_id: ws.id })

    expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('confirm') })
    expect(getWorkspace(ws.id)).toBeDefined()
  })

  it('refuses a workspace that still holds canvases, even with confirm', async () => {
    const ws = team('Still Full')
    store.createCanvas('Inside', 'owner-id', ws.id)

    const reply = await callAs('owner-id', 'delete_workspace', { workspace_id: ws.id, confirm: true })

    expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('1 canvas') })
    expect(getWorkspace(ws.id)).toBeDefined()
  })

  it('lets only the owner delete', async () => {
    const ws = team('Owner Only')

    const byAdmin = await callAs('admin-id', 'delete_workspace', { workspace_id: ws.id, confirm: true })
    const byStranger = await callAs('stranger-id', 'delete_workspace', { workspace_id: ws.id, confirm: true })

    expect(byAdmin).toMatchObject({ isError: true, text: expect.stringContaining('owners') })
    expect(byStranger).toMatchObject({ isError: true, text: expect.stringContaining('no workspace with id') })
    expect(getWorkspace(ws.id)).toBeDefined()
  })

  it('deletes an empty workspace when the owner confirms', async () => {
    const ws = team('Empty One')

    const reply = await callAs('owner-id', 'delete_workspace', { workspace_id: ws.id, confirm: true })

    expect(reply.isError).toBe(false)
    expect(json(reply)).toMatchObject({ deleted: ws.id })
    expect(getWorkspace(ws.id)).toBeUndefined()
  })
})

describe('move_canvas_to_workspace', () => {
  it('moves a whole canvas in and back out, leaving every frame exactly as it was', async () => {
    const ws = team('Destination')
    const canvas = canvasWithFrames('owner-id')
    const before = frameSnapshot(canvas.id)

    const moved = await callAs('owner-id', 'move_canvas_to_workspace', { canvas_id: canvas.id, workspace_id: ws.id })

    expect(moved.isError).toBe(false)
    expect(json(moved)).toMatchObject({ canvas_id: canvas.id, workspace_id: ws.id, frame_count: 2 })
    expect(store.getCanvas(canvas.id)?.workspaceId).toBe(ws.id)
    expect(frameSnapshot(canvas.id)).toEqual(before)

    const out = await callAs('owner-id', 'move_canvas_to_workspace', { canvas_id: canvas.id, workspace_id: null })

    expect(out.isError).toBe(false)
    expect(store.getCanvas(canvas.id)?.workspaceId).toBeUndefined()
    expect(frameSnapshot(canvas.id)).toEqual(before)
  })

  it('refuses a workspace the account is not in', async () => {
    const elsewhere = createWorkspace('Elsewhere', 'stranger-id')
    const canvas = canvasWithFrames('owner-id')

    const reply = await callAs('owner-id', 'move_canvas_to_workspace', {
      canvas_id: canvas.id,
      workspace_id: elsewhere.id,
    })

    expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('no workspace with id') })
    expect(store.getCanvas(canvas.id)?.workspaceId).toBeUndefined()
  })

  it('refuses a canvas the account cannot edit', async () => {
    const ws = createWorkspace('Stranger Space', 'stranger-id')
    const canvas = canvasWithFrames('owner-id')

    const reply = await callAs('stranger-id', 'move_canvas_to_workspace', { canvas_id: canvas.id, workspace_id: ws.id })

    expect(reply).toMatchObject({ isError: true, text: expect.stringContaining(`no canvas with id ${canvas.id}`) })
    expect(store.getCanvas(canvas.id)?.workspaceId).toBeUndefined()
  })

  it("lets a workspace admin move a member's canvas out, but not into another workspace", async () => {
    const ws = team('Source')
    const adminsOwn = createWorkspace('Admin Elsewhere', 'admin-id')
    const canvas = canvasWithFrames('member-id', ws.id)

    const rehome = await callAs('admin-id', 'move_canvas_to_workspace', {
      canvas_id: canvas.id,
      workspace_id: adminsOwn.id,
    })
    expect(rehome).toMatchObject({ isError: true, text: expect.stringContaining('only the canvas owner') })
    expect(store.getCanvas(canvas.id)?.workspaceId).toBe(ws.id)

    const out = await callAs('admin-id', 'move_canvas_to_workspace', { canvas_id: canvas.id, workspace_id: null })
    expect(out.isError).toBe(false)
    expect(store.getCanvas(canvas.id)?.workspaceId).toBeUndefined()
  })

  it('refuses a plain member moving a teammate’s canvas out', async () => {
    const ws = team('Members Stay')
    const canvas = canvasWithFrames('admin-id', ws.id)

    const reply = await callAs('member-id', 'move_canvas_to_workspace', { canvas_id: canvas.id, workspace_id: null })

    expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('workspace admin') })
    expect(store.getCanvas(canvas.id)?.workspaceId).toBe(ws.id)
  })
})
