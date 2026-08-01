// Combining a read-aloud into one recording (story 4.6).
//
// Read-aloud speaks a script one line at a time and times the silences
// locally, which is what keeps the spoken-position highlight working — but it
// leaves nothing behind to listen to away from the app. Export renders the
// same plan into a single file: every utterance is synthesised and decoded,
// the pacing marks become real silence, and the pieces are laid end to end.
//
// The split mirrors the rest of speech. Assembling and encoding samples are
// pure functions over buffers, and the two things that need a browser —
// synthesising an utterance and decoding compressed audio — are injected, so
// the pacing of an export is testable without any audio API.

import type { SpeechPlanItem } from './speech'

// Hosted text-to-speech returns mono at around this rate, so rendering to
// mono at 24 kHz keeps the voice as it arrived while holding an hour-long
// script to a size the browser can still hand to a download.
export const EXPORT_SAMPLE_RATE = 24000

// Utterances fetched ahead of the one being decoded. Enough to keep the
// network busy through a long script without opening a request per line:
// every one of them is billed, and tripping a rate limit costs more time than
// the extra parallelism saves.
const LOOKAHEAD = 3

const WAV_HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 2

// The shape of decoded audio this module needs, which is what
// AudioBuffer already is — stated structurally so the assembly can be tested
// against a plain object.
export interface DecodedAudio {
  numberOfChannels: number
  length: number
  getChannelData(channel: number): Float32Array
}

export type RecordingSegment =
  | { kind: 'audio'; samples: Int16Array }
  | { kind: 'silence'; durationMs: number }

export interface SpeechExportProgress {
  completed: number
  total: number
}

export interface SpeechExportRequest {
  plan: SpeechPlanItem[]
  // The read-aloud rate, applied to the recording as well.
  rate?: number
  synthesize: (text: string) => Promise<Blob>
  decode: (audio: Blob) => Promise<DecodedAudio>
  onProgress?: (progress: SpeechExportProgress) => void
  signal?: AbortSignal
  sampleRate?: number
}

// A cancelled export is an outcome, not a failure: the caller reports every
// other rejection but simply drops this one.
export class SpeechExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'SpeechExportCancelled'
  }
}

export function isSpeechExportCancelled(error: unknown): boolean {
  return (
    error instanceof SpeechExportCancelled ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

// Decoding needs no output device and no user gesture, so an offline context
// is the right one to ask — and decodeAudioData resamples to that context's
// rate, which is how every utterance arrives at the export rate whatever the
// model returned.
export function isSpeechExportSupported(): boolean {
  return typeof OfflineAudioContext !== 'undefined'
}

export function createSpeechDecoder(
  sampleRate: number = EXPORT_SAMPLE_RATE
): (audio: Blob) => Promise<DecodedAudio> {
  const context = new OfflineAudioContext(1, 1, sampleRate)
  return async (audio) => context.decodeAudioData(await audio.arrayBuffer())
}

function silenceSampleCount(durationMs: number, sampleRate: number): number {
  return Math.max(0, Math.round((durationMs / 1000) * sampleRate))
}

// Decoded audio arrives as floats between -1 and 1, one array per channel.
// The recording is mono, so extra channels are averaged in rather than
// dropped, and values are clamped before scaling because decoders can
// overshoot the nominal range slightly.
export function toMonoSamples(audio: DecodedAudio): Int16Array {
  const samples = new Int16Array(audio.length)
  if (audio.numberOfChannels === 0) return samples

  const channels: Float32Array[] = []
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    channels.push(audio.getChannelData(channel))
  }

  for (let index = 0; index < audio.length; index += 1) {
    let total = 0
    for (const channel of channels) total += channel[index]
    const value = Math.max(-1, Math.min(1, total / channels.length))
    // Negative samples have one more step of headroom than positive ones.
    samples[index] = Math.round(value * (value < 0 ? 0x8000 : 0x7fff))
  }
  return samples
}

// The chosen rate applies to the recording as well as to playback. Silence is
// simply shortened; the voice is resampled, which speeds it the way a tape
// does, so the pitch moves with it — an export at 1x is untouched.
export function applyRate(samples: Int16Array, rate: number): Int16Array {
  if (rate === 1 || samples.length === 0) return samples

  const length = Math.max(1, Math.round(samples.length / rate))
  const resampled = new Int16Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index * rate
    const left = Math.min(Math.floor(position), samples.length - 1)
    const right = Math.min(left + 1, samples.length - 1)
    const fraction = position - left
    resampled[index] = Math.round(samples[left] * (1 - fraction) + samples[right] * fraction)
  }
  return resampled
}

// Lays the segments end to end in one buffer. Silence needs nothing written —
// a fresh buffer is already zeroed — so a gap is just an advanced offset.
export function assembleRecording(
  segments: RecordingSegment[],
  sampleRate: number = EXPORT_SAMPLE_RATE
): Int16Array {
  const lengthOf = (segment: RecordingSegment) =>
    segment.kind === 'audio'
      ? segment.samples.length
      : silenceSampleCount(segment.durationMs, sampleRate)

  const recording = new Int16Array(segments.reduce((total, segment) => total + lengthOf(segment), 0))
  let offset = 0
  for (const segment of segments) {
    if (segment.kind === 'audio') recording.set(segment.samples, offset)
    offset += lengthOf(segment)
  }
  return recording
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}

// Uncompressed 16-bit mono PCM in a WAV container: the one audio format a
// browser can write without a codec, and one every player opens.
export function encodeWav(samples: Int16Array, sampleRate: number = EXPORT_SAMPLE_RATE): Blob {
  const dataBytes = samples.length * BYTES_PER_SAMPLE
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // everything in the file after this field
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // length of this format chunk
  view.setUint16(20, 1, true) // uncompressed PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true) // bytes per second
  view.setUint16(32, BYTES_PER_SAMPLE, true) // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  // WAV samples are little-endian, which is also how a typed array writes
  // them on every platform that runs a browser.
  new Int16Array(buffer, WAV_HEADER_BYTES).set(samples)

  return new Blob([buffer], { type: 'audio/wav' })
}

export function countUtterances(plan: SpeechPlanItem[]): number {
  return plan.filter((item) => item.kind === 'speech').length
}

function stopIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SpeechExportCancelled()
}

// Walks the speech plan in order, fetching a few utterances ahead of the one
// being decoded, and returns the finished recording. Progress is reported per
// utterance, since that is what the requests are billed and timed by.
export async function renderSpeechExport({
  plan,
  rate = 1,
  synthesize,
  decode,
  onProgress,
  signal,
  sampleRate = EXPORT_SAMPLE_RATE,
}: SpeechExportRequest): Promise<Blob> {
  const utterances = plan.filter(
    (item): item is Extract<SpeechPlanItem, { kind: 'speech' }> => item.kind === 'speech'
  )

  stopIfCancelled(signal)

  const pending = new Map<number, Promise<Blob>>()
  const request = (position: number) => {
    if (signal?.aborted || position >= utterances.length || pending.has(position)) return
    const audio = synthesize(utterances[position].text)
    // Awaited in order below; this only stops a failure several lines ahead
    // from surfacing as an unhandled rejection in the meantime.
    audio.catch(() => {})
    pending.set(position, audio)
  }

  for (let position = 0; position < LOOKAHEAD; position += 1) request(position)

  const segments: RecordingSegment[] = []
  let completed = 0

  for (const item of plan) {
    stopIfCancelled(signal)

    if (item.kind === 'pause') {
      segments.push({ kind: 'silence', durationMs: item.durationMs / rate })
      continue
    }

    const audio = await pending.get(completed)!
    pending.delete(completed)
    request(completed + LOOKAHEAD)

    const decoded = await decode(audio)
    segments.push({ kind: 'audio', samples: applyRate(toMonoSamples(decoded), rate) })
    completed += 1
    onProgress?.({ completed, total: utterances.length })
  }

  stopIfCancelled(signal)
  return encodeWav(assembleRecording(segments, sampleRate), sampleRate)
}
