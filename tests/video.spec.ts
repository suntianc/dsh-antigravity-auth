import { describe, expect, it, vi } from 'vitest'
import { createAntigravityVideoTools } from '../src/video.ts'
import type { AntigravityVideoToolOptions } from '../src/video.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const mp4 = new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])
const agent = { session: { header: { cwd: '/workspace' }, snapshotEvents: () => [] } } as never
const exec = { agent, signal: new AbortController().signal } as unknown as ToolRunContext

function options(overrides: Partial<AntigravityVideoToolOptions> = {}): AntigravityVideoToolOptions {
  return {
    auth: { credential: vi.fn(async () => ({ accessToken: 'secret', refreshToken: 'refresh', expiresAt: 0, projectId: 'project-id' })) },
    fs: {
      resolve: vi.fn(async (value: string) => ({ targetKey: value as never, displayPath: value })),
      contains: vi.fn(() => true),
      lstat: vi.fn(async () => ({ type: 'file' as const, version: 'version' as never })),
      stat: vi.fn(async () => ({ type: 'file' as const, version: 'version' as never })),
      readBytes: vi.fn(async () => mp4),
    },
    transport: {
      request: vi.fn(async () => new Response(JSON.stringify({ response: { parts: [{ text: 'frame fact' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } } }))),
    },
    ...overrides,
  }
}

describe('gated video understanding POC', () => {
  it('does not register or execute the default-disabled capability', async () => {
    const tool = createAntigravityVideoTools(options({ settings: () => ({ enabled: false, model: 'antigravity-gemini-3.8-flash' }) }))[0]!
    await expect(tool.execute({}, exec)).rejects.toMatchObject({ code: 'VIDEO_DISABLED' })
  })

  it('returns only bounded text and usage, never the workspace path', async () => {
    const tool = createAntigravityVideoTools(options({ settings: () => ({ enabled: true, model: 'antigravity-gemini-3.8-flash' }) }))[0]!
    const result = await tool.execute({ path: 'clip.mp4', prompt: 'What is visible?' }, exec)
    expect(result).toEqual({ text: 'frame fact', usage: { inputTokens: 2, outputTokens: 3 } })
    expect(JSON.stringify(result)).not.toContain('clip.mp4')
  })
})
