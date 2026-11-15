import { describe, expect, it, vi } from 'vitest'
import { LIVE_ACKNOWLEDGEMENT, runLiveGateCli } from '../src/live-gates.ts'
import {
  LIVE_VIDEO_EXPECTED_ANSWER,
  LIVE_VIDEO_QUESTION,
  classifyGate0Outcome,
  isDeterministicVideoAnswer,
  runLlmGate,
} from '../src/live-gate-runner.ts'
import { createMemoryCapabilityGates } from '../src/capability-gates.ts'

describe('opt-in live gate CLI', () => {
  it('touches neither credentials nor network before both explicit acknowledgements', async () => {
    const createRunner = vi.fn()
    const error = vi.fn()

    const exitCode = await runLiveGateCli(['--gate', 'S'], {}, { createRunner, output: vi.fn(), error })

    expect(exitCode).toBe(2)
    expect(createRunner).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('explicit acknowledgement'))
  })

  it('runs exactly one independently selected gate after the flag and environment acknowledgement', async () => {
    const run = vi.fn(async () => ({ gate: 'S' as const, outcome: 'passed' as const }))
    const createRunner = vi.fn(() => ({ run, dispose: vi.fn(async () => {}) }))
    const output = vi.fn()

    const exitCode = await runLiveGateCli(
      ['--acknowledge-private-risk', '--gate', 'S'],
      { DSH_ANTIGRAVITY_LIVE_ACK: LIVE_ACKNOWLEDGEMENT },
      { createRunner, output, error: vi.fn() },
    )

    expect(exitCode).toBe(0)
    expect(createRunner).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('S', expect.objectContaining({}))
    expect(output).toHaveBeenCalledWith('{"gate":"S","outcome":"passed"}')
  })

  it('runs Gate 0/L as one minimal generation without a catalog probe', async () => {
    const listModels = vi.fn()
    const stream = vi.fn(async function* () {
      yield { type: 'block-start' as const, block: 'text' as const, index: 0 }
      yield { type: 'text-delta' as const, index: 0, text: 'ok' }
      yield { type: 'block-end' as const, index: 0 }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })
    const gates = createMemoryCapabilityGates()
    const auth = { recordGate0: vi.fn(), recordLlmFamilyGate: vi.fn() }

    await expect(runLlmGate(auth as never, gates, undefined, { listModels, stream } as never)).resolves.toEqual({ gate: '0L', outcome: 'passed' })
    expect(stream).toHaveBeenCalledOnce()
    expect(listModels).not.toHaveBeenCalled()
    expect(auth.recordGate0).toHaveBeenCalledWith('passed')
    expect(auth.recordLlmFamilyGate).not.toHaveBeenCalled()
  })

  it.each([
    ['gemini', 'antigravity-gemini-3.8-flash'],
    ['claude', 'antigravity-claude-sonnet-5-5'],
    ['gpt-oss', 'antigravity-gpt-oss-120b-medium'],
  ] as const)('runs and records only the selected %s family fixture', async (family, expectedModel) => {
    const auth = { recordGate0: vi.fn(), recordLlmFamilyGate: vi.fn() }
    const stream = vi.fn(async function* (options: { model: string }) {
      expect(options.model).toBe(expectedModel)
      yield { type: 'text-delta' as const, index: 0, text: family }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })

    await expect(runLlmGate(auth as never, createMemoryCapabilityGates(), family, { stream } as never)).resolves.toEqual({
      gate: '0L',
      outcome: 'passed',
    })
    expect(auth.recordLlmFamilyGate).toHaveBeenCalledWith(family, 'passed')
    expect(auth.recordGate0).not.toHaveBeenCalled()
  })

  it('preserves a safe embedded provider failure code in the Gate 0 outcome', async () => {
    const auth = { recordGate0: vi.fn(), recordLlmFamilyGate: vi.fn() }
    const stream = vi.fn(async function* () {
      yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'RESOURCE_EXHAUSTED', message: 'safe' } } }
    })

    await expect(runLlmGate(auth as never, createMemoryCapabilityGates(), undefined, { stream } as never)).resolves.toEqual({
      gate: '0L',
      outcome: 'rate-limited',
    })
    expect(auth.recordGate0).toHaveBeenCalledWith('rate-limited')
  })

  it('keeps generic forbidden failures distinct from demonstrated attribution rejection', () => {
    expect(classifyGate0Outcome(Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }))).toBe('failed')
    expect(classifyGate0Outcome(Object.assign(new Error('attribution'), { code: 'GATE_0_ATTRIBUTION' }))).toBe('attribution-rejected')
  })

  it('uses a deterministic pixel-fact video question and verifies the exact fixture answer', () => {
    expect(LIVE_VIDEO_QUESTION).not.toContain(LIVE_VIDEO_EXPECTED_ANSWER)
    expect(isDeterministicVideoAnswer(LIVE_VIDEO_EXPECTED_ANSWER)).toBe(true)
    expect(isDeterministicVideoAnswer(`The answer is ${LIVE_VIDEO_EXPECTED_ANSWER}.`)).toBe(false)
    expect(isDeterministicVideoAnswer(LIVE_VIDEO_EXPECTED_ANSWER.toLowerCase())).toBe(false)
    expect(isDeterministicVideoAnswer(` ${LIVE_VIDEO_EXPECTED_ANSWER}`)).toBe(false)
    expect(isDeterministicVideoAnswer(`${LIVE_VIDEO_EXPECTED_ANSWER}\n`)).toBe(false)
    expect(isDeterministicVideoAnswer('some visible fact')).toBe(false)
  })

  it('selects exactly one independent LLM family fixture under Gate 0/L', async () => {
    const run = vi.fn(async () => ({ gate: '0L' as const, outcome: 'passed' as const }))
    const createRunner = vi.fn(async () => ({ run, dispose: vi.fn(async () => {}) }))
    const acknowledged = { DSH_ANTIGRAVITY_LIVE_ACK: LIVE_ACKNOWLEDGEMENT }

    await expect(runLiveGateCli(
      ['--acknowledge-private-risk', '--gate', '0L', '--family', 'claude'],
      acknowledged,
      { createRunner, output: vi.fn(), error: vi.fn() },
    )).resolves.toBe(0)
    expect(run).toHaveBeenCalledWith('0L', { llmFamily: 'claude' })
  })

  it('rejects bulk, unknown, or misplaced family selection before creating the runner', async () => {
    const createRunner = vi.fn()
    const acknowledged = { DSH_ANTIGRAVITY_LIVE_ACK: LIVE_ACKNOWLEDGEMENT }
    const dependencies = { createRunner, output: vi.fn(), error: vi.fn() }

    await expect(runLiveGateCli(['--acknowledge-private-risk', '--gate', 'S', '--gate', 'I'], acknowledged, dependencies)).resolves.toBe(2)
    await expect(runLiveGateCli(['--acknowledge-private-risk', '--gate', 'ALL'], acknowledged, dependencies)).resolves.toBe(2)
    await expect(runLiveGateCli(['--acknowledge-private-risk', '--gate', '0L', '--family', 'unknown'], acknowledged, dependencies)).resolves.toBe(2)
    await expect(runLiveGateCli(['--acknowledge-private-risk', '--gate', 'S', '--family', 'gemini'], acknowledged, dependencies)).resolves.toBe(2)
    expect(createRunner).not.toHaveBeenCalled()
  })
})
