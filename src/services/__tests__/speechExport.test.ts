import { describe, expect, it, vi } from 'vitest'
import { buildSpeechPlan, PARAGRAPH_PAUSE_MS, type SpeechPlanItem } from '../speech'
import {
  applyRate,
  assembleRecording,
  countUtterances,
  encodeWav,
  isSpeechExportCancelled,
  renderSpeechExport,
  toMonoSamples,
  type DecodedAudio,
} from '../speechExport'

const SAMPLE_RATE = 1000

// Decoded audio of a known length and value, so an utterance can be
// recognised by its samples once it is laid into the recording.
const decodedTone = (length: number, value: number): DecodedAudio => ({
  numberOfChannels: 1,
  length,
  getChannelData: () => new Float32Array(length).fill(value),
})

describe('toMonoSamples', () => {
  it('scales floats to full-range 16-bit samples', () => {
    expect(Array.from(toMonoSamples(decodedTone(2, 1)))).toEqual([32767, 32767])
    expect(Array.from(toMonoSamples(decodedTone(2, -1)))).toEqual([-32768, -32768])
    expect(Array.from(toMonoSamples(decodedTone(1, 0)))).toEqual([0])
  })

  it('averages a stereo utterance rather than dropping a channel', () => {
    const stereo: DecodedAudio = {
      numberOfChannels: 2,
      length: 1,
      getChannelData: (channel) => new Float32Array([channel === 0 ? 1 : -1]),
    }
    expect(Array.from(toMonoSamples(stereo))).toEqual([0])
  })

  it('clamps a decoder that overshoots the nominal range', () => {
    expect(Array.from(toMonoSamples(decodedTone(1, 1.5)))).toEqual([32767])
  })
})

describe('applyRate', () => {
  it('leaves the voice untouched at 1x', () => {
    const samples = new Int16Array([1, 2, 3])
    expect(applyRate(samples, 1)).toBe(samples)
  })

  it('shortens the voice as the rate rises', () => {
    expect(applyRate(new Int16Array(100).fill(500), 2)).toHaveLength(50)
    expect(applyRate(new Int16Array(100).fill(500), 0.5)).toHaveLength(200)
  })

  it('keeps the level of a steady tone through the resample', () => {
    expect(Array.from(applyRate(new Int16Array(8).fill(1000), 2))).toEqual(new Array(4).fill(1000))
  })
})

describe('assembleRecording', () => {
  it('lays utterances end to end with silence between them', () => {
    const recording = assembleRecording(
      [
        { kind: 'audio', samples: new Int16Array([7, 7]) },
        { kind: 'silence', durationMs: 3000 },
        { kind: 'audio', samples: new Int16Array([9]) },
      ],
      SAMPLE_RATE
    )

    expect(recording).toHaveLength(2 + 3000 + 1)
    expect(Array.from(recording.slice(0, 2))).toEqual([7, 7])
    // The gap is real silence, not a join.
    expect(recording.slice(2, 3002).every((sample) => sample === 0)).toBe(true)
    expect(recording[3002]).toBe(9)
  })

  it('measures silence in samples at the recording rate', () => {
    expect(assembleRecording([{ kind: 'silence', durationMs: 500 }], SAMPLE_RATE)).toHaveLength(500)
  })
})

describe('encodeWav', () => {
  const headerOf = async (blob: Blob) => new DataView(await blob.arrayBuffer())
  const ascii = (view: DataView, offset: number, length: number) =>
    String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)))

  it('writes a 16-bit mono PCM header describing the samples', async () => {
    const view = await headerOf(encodeWav(new Int16Array([1, -1, 300]), 24000))

    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1) // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(24000)
    expect(view.getUint32(28, true)).toBe(48000) // bytes per second
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(ascii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getUint32(4, true)).toBe(42)
  })

  it('writes the samples after the header, little-endian', async () => {
    const view = await headerOf(encodeWav(new Int16Array([1, -1, 300]), 24000))

    expect(view.getInt16(44, true)).toBe(1)
    expect(view.getInt16(46, true)).toBe(-1)
    expect(view.getInt16(48, true)).toBe(300)
  })

  it('is announced as audio a player will open', () => {
    expect(encodeWav(new Int16Array(0), 24000).type).toBe('audio/wav')
  })
})

// Stands in for the hosted voice: each utterance decodes to a run of samples
// as long as its text, at a level that identifies which line it was.
const exportHarness = () => {
  const levels = new Map<string, number>()
  let nextLevel = 0

  const synthesize = vi.fn(async (text: string) => {
    nextLevel += 1
    levels.set(text, nextLevel / 100)
    return new Blob([text])
  })

  const decode = async (audio: Blob) => {
    const text = await audio.text()
    return decodedTone(text.length, levels.get(text)!)
  }

  return { synthesize, decode, spokenTexts: () => synthesize.mock.calls.map(([text]) => text) }
}

const samplesOf = async (recording: Blob): Promise<Int16Array> => {
  const buffer = await recording.arrayBuffer()
  return new Int16Array(buffer.slice(44))
}

describe('renderSpeechExport', () => {
  const plan = () => buildSpeechPlan([{ content: '## Induction\nOne.\nTwo.' }])

  it('records every line of the plan with its pacing silence between them', async () => {
    const { synthesize, decode, spokenTexts } = exportHarness()

    const recording = await renderSpeechExport({
      plan: plan(),
      synthesize,
      decode,
      sampleRate: SAMPLE_RATE,
    })

    expect(spokenTexts()).toEqual(['One.', 'Two.'])
    const samples = await samplesOf(recording)
    // Both utterances are four characters long, either side of the silence
    // the paragraph break asks for.
    expect(samples).toHaveLength(4 + PARAGRAPH_PAUSE_MS + 4)
    expect(samples.slice(4, 4 + PARAGRAPH_PAUSE_MS).every((sample) => sample === 0)).toBe(true)
    expect(samples[0]).not.toBe(samples[samples.length - 1])
  })

  it('never sends a section heading or a stage direction to be voiced', async () => {
    const { synthesize, decode, spokenTexts } = exportHarness()

    await renderSpeechExport({
      plan: buildSpeechPlan([{ content: '## Deepener\nSettle back. [long pause] Good.' }]),
      synthesize,
      decode,
      sampleRate: SAMPLE_RATE,
    })

    expect(spokenTexts()).toEqual(['Settle back.', 'Good.'])
  })

  it('scales the silence by the chosen rate, as read-aloud does', async () => {
    const { synthesize, decode } = exportHarness()

    const recording = await renderSpeechExport({
      plan: plan(),
      rate: 2,
      synthesize,
      decode,
      sampleRate: SAMPLE_RATE,
    })

    const samples = await samplesOf(recording)
    expect(samples).toHaveLength(2 + PARAGRAPH_PAUSE_MS / 2 + 2)
  })

  it('reports progress by utterance, which is what is billed', async () => {
    const { synthesize, decode } = exportHarness()
    const progress: Array<[number, number]> = []

    await renderSpeechExport({
      plan: plan(),
      synthesize,
      decode,
      sampleRate: SAMPLE_RATE,
      onProgress: ({ completed, total }) => progress.push([completed, total]),
    })

    expect(progress).toEqual([[1, 2], [2, 2]])
  })

  it('asks for each utterance once, so a repeated line is not paid for twice over', async () => {
    const { synthesize, decode } = exportHarness()

    await renderSpeechExport({
      plan: plan(),
      synthesize,
      decode,
      sampleRate: SAMPLE_RATE,
    })

    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it('pays once for a line the script repeats', async () => {
    const { synthesize, decode, spokenTexts } = exportHarness()

    const recording = await renderSpeechExport({
      plan: buildSpeechPlan([{ content: 'Deeper now.\nAnd again.\nDeeper now.' }]),
      synthesize,
      decode,
      sampleRate: SAMPLE_RATE,
    })

    expect(spokenTexts()).toEqual(['Deeper now.', 'And again.'])
    // The repeat is still in the recording, in its own place.
    const samples = await samplesOf(recording)
    expect(samples.slice(0, 11)).toEqual(samples.slice(-11))
  })

  it('stops without a recording once cancelled', async () => {
    const { synthesize, decode } = exportHarness()
    const controller = new AbortController()
    controller.abort()

    await expect(
      renderSpeechExport({ plan: plan(), synthesize, decode, signal: controller.signal })
    ).rejects.toSatisfy(isSpeechExportCancelled)
    expect(synthesize).toHaveBeenCalledTimes(0)
  })

  it('gives up part-way when cancelled mid-render', async () => {
    const { synthesize, decode } = exportHarness()
    const controller = new AbortController()

    await expect(
      renderSpeechExport({
        plan: plan(),
        synthesize,
        decode,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      })
    ).rejects.toSatisfy(isSpeechExportCancelled)
  })

  it('reports a failed utterance rather than writing a recording with a hole in it', async () => {
    const { decode } = exportHarness()
    const synthesize = vi.fn(async () => {
      throw new Error('Insufficient credits')
    })

    await expect(
      renderSpeechExport({ plan: plan(), synthesize, decode })
    ).rejects.toThrow('Insufficient credits')
  })

  it('records a plan of nothing but silence without asking for a voice', async () => {
    const { synthesize, decode } = exportHarness()
    const silence: SpeechPlanItem[] = [
      { kind: 'pause', durationMs: 250, paragraphKey: 'line-0-0' },
    ]

    const recording = await renderSpeechExport({
      plan: silence,
      synthesize,
      decode,
      sampleRate: SAMPLE_RATE,
    })

    expect(synthesize).not.toHaveBeenCalled()
    expect(await samplesOf(recording)).toHaveLength(250)
  })
})

describe('countUtterances', () => {
  it('counts only the lines that will be voiced', () => {
    expect(countUtterances(buildSpeechPlan([{ content: '## Induction\nOne.\nTwo.' }]))).toBe(2)
  })
})
