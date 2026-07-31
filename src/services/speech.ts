// Read-aloud support for performance mode (stories 4.4 and 4.5).
//
// The pure parts — chunking script text into utterances and computing pause
// lengths from pacing marks — live here so they can be unit tested without any
// audio API. ScriptSpeaker walks that plan and hands each utterance to a
// SpeechEngine (browser speech synthesis, or an OpenRouter text-to-speech
// model), so pacing is identical whichever voice is chosen.

import { tokenizeScriptLine } from '../utils/scriptLineTokens'
import type { SpeechEngine } from './speechEngines'

export const ELLIPSIS_PAUSE_MS = 600
export const DASH_PAUSE_MS = 1200
export const PARAGRAPH_PAUSE_MS = 800

export type SpeechPlanItem =
  | { kind: 'speech'; text: string; paragraphKey: string }
  | { kind: 'pause'; durationMs: number; paragraphKey: string }

export interface SpeechPlanSection {
  content: string
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
}

// A pacing mark maps to silence: each … is a short beat, each ⏤ a long one,
// and a run of literal dots counts as one beat per group of three.
export function pauseDurationMs(mark: string): number {
  let total = 0
  for (const character of mark) {
    if (character === '…') total += ELLIPSIS_PAUSE_MS
    else if (character === '⏤') total += DASH_PAUSE_MS
  }
  const dotCount = mark.split('').filter((character) => character === '.').length
  if (dotCount >= 3) total += Math.floor(dotCount / 3) * ELLIPSIS_PAUSE_MS
  return total
}

// Turns script sections into an ordered plan of utterances and pauses.
// Paragraph keys mirror the `line-{section}-{line}` keys the performance view
// renders, so the caller can map the spoken position back to a paragraph.
// Stage directions are display-only and never spoken; blank lines and the
// gaps between paragraphs become pauses.
export function buildSpeechPlan(sections: SpeechPlanSection[]): SpeechPlanItem[] {
  const items: SpeechPlanItem[] = []

  sections.forEach((section, sectionIndex) => {
    section.content.split('\n').forEach((line, lineIndex) => {
      if (!line.trim() || line.startsWith('## ')) return
      const paragraphKey = `line-${sectionIndex}-${lineIndex}`

      if (items.length > 0) {
        items.push({ kind: 'pause', durationMs: PARAGRAPH_PAUSE_MS, paragraphKey })
      }

      let chunk = ''
      for (const token of tokenizeScriptLine(line)) {
        if (token.kind === 'text') {
          chunk += token.text
        } else {
          if (chunk.trim()) {
            items.push({ kind: 'speech', text: chunk.trim(), paragraphKey })
            chunk = ''
          }
          if (token.kind === 'pacing') {
            const durationMs = pauseDurationMs(token.text)
            if (durationMs > 0) {
              items.push({ kind: 'pause', durationMs, paragraphKey })
            }
          }
          // Stage directions end the current utterance but are never spoken.
        }
      }
      if (chunk.trim()) {
        items.push({ kind: 'speech', text: chunk.trim(), paragraphKey })
      }
    })
  })

  return items
}

export interface ScriptSpeakerCallbacks {
  onParagraphSpoken: (paragraphKey: string) => void
  onFinished: () => void
  onFailed: (message: string) => void
}

// Imperative driver for the speech plan. Speaks each utterance through the
// engine, waits out each pause (scaled by the chosen rate), and reports the
// paragraph being spoken so the view can follow along. pause()/resume() work
// both mid-utterance (delegated to the engine) and mid-silence (by suspending
// the timer).
export class ScriptSpeaker {
  private index = 0
  private stopped = false
  private paused = false
  private timerId: ReturnType<typeof setTimeout> | null = null
  private pauseRemainingMs = 0
  private pauseStartedAt = 0
  private rate: number
  private readonly plan: SpeechPlanItem[]
  private readonly engine: SpeechEngine
  private readonly callbacks: ScriptSpeakerCallbacks

  constructor(
    plan: SpeechPlanItem[],
    engine: SpeechEngine,
    options: { rate: number },
    callbacks: ScriptSpeakerCallbacks
  ) {
    this.plan = plan
    this.engine = engine
    this.callbacks = callbacks
    this.rate = options.rate
  }

  start() {
    this.engine.reset()
    this.advance()
  }

  pause() {
    if (this.paused || this.stopped) return
    this.paused = true
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
      this.pauseRemainingMs = Math.max(0, this.pauseRemainingMs - (Date.now() - this.pauseStartedAt))
    } else {
      this.engine.pause()
    }
  }

  resume() {
    if (!this.paused || this.stopped) return
    this.paused = false
    if (this.pauseRemainingMs > 0) {
      this.startTimer(this.pauseRemainingMs)
    } else {
      this.engine.resume()
    }
  }

  stop() {
    this.stopped = true
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
    this.engine.cancel()
  }

  setVoice(voice: string) {
    this.engine.setVoice(voice)
  }

  setRate(rate: number) {
    this.rate = rate
  }

  private advance() {
    if (this.stopped) return
    if (this.index >= this.plan.length) {
      this.callbacks.onFinished()
      return
    }
    const item = this.plan[this.index]
    this.index += 1
    this.callbacks.onParagraphSpoken(item.paragraphKey)

    if (item.kind === 'pause') {
      this.startTimer(item.durationMs / this.rate)
      return
    }

    this.prefetchNextUtterance()
    this.engine.speak(item.text, this.rate).then(
      () => {
        if (!this.stopped) this.advance()
      },
      (error: unknown) => {
        if (this.stopped) return
        this.stop()
        this.callbacks.onFailed(
          error instanceof Error ? error.message : 'Read-aloud stopped unexpectedly'
        )
      }
    )
  }

  // Gives a network-backed engine the length of the current utterance and the
  // silence after it to fetch the next one.
  private prefetchNextUtterance() {
    for (let index = this.index; index < this.plan.length; index += 1) {
      const item = this.plan[index]
      if (item.kind === 'speech') {
        this.engine.prefetch(item.text)
        return
      }
    }
  }

  private startTimer(durationMs: number) {
    this.pauseRemainingMs = durationMs
    this.pauseStartedAt = Date.now()
    this.timerId = setTimeout(() => {
      this.timerId = null
      this.pauseRemainingMs = 0
      this.advance()
    }, durationMs)
  }
}
