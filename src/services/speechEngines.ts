// The two ways a script can be read aloud (stories 4.4 and 4.5).
//
// ScriptSpeaker owns the plan — which lines are spoken and how long the
// silences between them last — and delegates the actual voicing to a
// SpeechEngine. That split keeps the pacing identical whichever engine is
// chosen, and keeps the plan testable without any audio API.
//
// Both engines are imperative handles onto browser media APIs, in the same
// spirit as the existing speechSynthesis usage: they live in the service layer
// and never touch the React tree.

import { synthesizeSpeech, type SynthesisRequest } from './openrouterTts'
import { readCachedAudio, speechCacheKey, writeCachedAudio } from './speechAudioCache'

// One utterance's audio: from the cache when that exact line has been
// synthesised before, and from the model when it has not. Read-aloud and
// export share it, so a line already heard costs nothing to record — and a
// recorded script replays free.
export async function fetchUtteranceAudio({
  apiKey,
  model,
  voice,
  text,
  signal,
}: SynthesisRequest): Promise<Blob> {
  const key = speechCacheKey(model, voice, text)
  const cached = await readCachedAudio(key)
  if (cached) return cached

  const audio = await synthesizeSpeech({ apiKey, model, voice, text, signal })
  await writeCachedAudio(key, audio)
  return audio
}

export interface SpeechEngine {
  // Resolves when the utterance has finished; rejects if it could not be
  // spoken at all, which stops read-aloud and surfaces a message.
  speak(text: string, rate: number): Promise<void>
  // Optional head start on the next utterance, so paid engines are not
  // fetching during the silence the listener can hear.
  prefetch(text: string): void
  setVoice(voice: string): void
  // Clears anything left over from a previous read, leaving the engine ready to
  // speak. Distinct from cancel(), which retires the engine for good.
  reset(): void
  pause(): void
  resume(): void
  cancel(): void
}

// Browser speech synthesis: free, offline, and voiced by whatever the platform
// installs. Voices are addressed by voiceURI; an empty id means the default.
export class BrowserSpeechEngine implements SpeechEngine {
  private voiceURI: string

  constructor(voiceURI = '') {
    this.voiceURI = voiceURI
  }

  setVoice(voice: string) {
    this.voiceURI = voice
  }

  speak(text: string, rate: number): Promise<void> {
    return new Promise((resolve) => {
      const utterance = new window.SpeechSynthesisUtterance(text)
      const voice = this.voiceURI
        ? window.speechSynthesis.getVoices().find((candidate) => candidate.voiceURI === this.voiceURI)
        : undefined
      if (voice) utterance.voice = voice
      utterance.rate = rate
      // A failed utterance is skipped rather than fatal: the platform reports
      // errors for things as ordinary as an interrupted queue.
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve()
      window.speechSynthesis.speak(utterance)
    })
  }

  prefetch() {
    // Nothing to fetch — the platform synthesises locally.
  }

  // The platform queue survives a previous read, so drop anything still on it.
  reset() {
    window.speechSynthesis.cancel()
  }

  pause() {
    window.speechSynthesis.pause()
  }

  resume() {
    window.speechSynthesis.resume()
  }

  cancel() {
    window.speechSynthesis.cancel()
  }
}

export interface OpenRouterSpeechEngineOptions {
  apiKey: string
  model: string
  voice: string
}

// OpenRouter text-to-speech: one request per utterance, cached by text so a
// replay of an unchanged script costs nothing. Requests for the next line
// start while the current one is still playing.
export class OpenRouterSpeechEngine implements SpeechEngine {
  private readonly apiKey: string
  private readonly model: string
  private voice: string
  private readonly controller = new AbortController()
  private readonly inFlight = new Map<string, Promise<Blob>>()
  private audio: HTMLAudioElement | null = null
  private paused = false
  private cancelled = false
  private releasePause: (() => void) | null = null
  private pauseGate: Promise<void> | null = null

  constructor({ apiKey, model, voice }: OpenRouterSpeechEngineOptions) {
    this.apiKey = apiKey
    this.model = model
    this.voice = voice
  }

  setVoice(voice: string) {
    this.voice = voice
  }

  private load(text: string): Promise<Blob> {
    const key = speechCacheKey(this.model, this.voice, text)
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const request = fetchUtteranceAudio({
      apiKey: this.apiKey,
      model: this.model,
      voice: this.voice,
      text,
      signal: this.controller.signal,
    })

    this.inFlight.set(key, request)
    // A failed request must not poison the cache slot, or a retry after a
    // transient error would replay the same rejection.
    request.catch(() => this.inFlight.delete(key))
    return request
  }

  prefetch(text: string) {
    if (this.cancelled) return
    this.load(text).catch(() => {
      // Reported when the utterance is actually reached, not from here.
    })
  }

  async speak(text: string, rate: number): Promise<void> {
    const audioBlob = await this.load(text)
    // A pause during the request (or a fetch that outlived a stop) must not
    // burst into sound the moment it resolves.
    await this.waitWhilePaused()
    if (this.cancelled) return

    const url = URL.createObjectURL(audioBlob)
    const audio = new Audio(url)
    audio.playbackRate = rate
    this.audio = audio

    try {
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve()
        audio.onerror = () => reject(new Error('The generated audio could not be played'))
        audio.play().catch(reject)
      })
    } finally {
      this.audio = null
      URL.revokeObjectURL(url)
    }
  }

  // A fresh engine is built for each read, so there is nothing to clear —
  // and cancelling here would abort the controller before the first request.
  reset() {}

  private waitWhilePaused(): Promise<void> {
    return this.pauseGate ?? Promise.resolve()
  }

  pause() {
    if (this.paused || this.cancelled) return
    this.paused = true
    this.pauseGate = new Promise<void>((resolve) => {
      this.releasePause = resolve
    })
    this.audio?.pause()
  }

  resume() {
    if (!this.paused || this.cancelled) return
    this.paused = false
    this.releasePause?.()
    this.releasePause = null
    this.pauseGate = null
    void this.audio?.play().catch(() => {
      // A play() rejected on resume is reported by the pending speak promise.
    })
  }

  cancel() {
    this.cancelled = true
    this.releasePause?.()
    this.releasePause = null
    this.pauseGate = null
    this.audio?.pause()
    this.audio = null
    this.controller.abort()
    this.inFlight.clear()
  }
}
