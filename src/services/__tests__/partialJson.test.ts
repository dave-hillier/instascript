import { describe, it, expect } from 'vitest'
import { scanPartialJsonObject } from '../partialJson'

// A realistic section_write payload: prose with paragraph breaks, quotation
// marks, a backslash, a forward slash, a tab, and a non-ASCII character.
const BODY = [
  'Settle back. Let the sound of my voice do the work — you need do nothing at all.',
  '',
  'She said, "you are already drifting", and the phrase \\ and the pause after it carried you down.',
  '',
  'Ten. Nine. Eight.\tSlower now. Half of what is left, then half again, and half of that.',
  '',
  'Read it back as instascript/examples/descent.md would have it: one long, unhurried line.',
].join('\n')

const PAYLOAD = JSON.stringify({ title: 'The Descent', body: BODY, index: 3, tags: ['a', 'b'] })

// The same shape as BODY, but carrying characters a provider is obliged to
// send as `\uXXXX`: a control character, which JSON.stringify always escapes,
// and an astral character, whose surrogate halves an ASCII-only encoder emits
// as two escapes that a cut can fall between.
const ESCAPED_BODY = [
  'Settle back. She said, "you are already drifting", and the pause \\ carried you down.',
  '',
  'Ten. Nine.\tEight — half of what is left, then half again. Café, naïve, résumé.',
  '',
  'A bell \u0007 and a smile \u{1f60a} and a lone brace { and "a decoy": "value" inside.',
].join('\n')

const ESCAPED_ARGS = {
  title: 'The Descent — Café',
  body: ESCAPED_BODY,
  index: 3,
  tags: ['a', 'b'],
  done: true,
}

// Re-encode a JSON text the way an ASCII-only serializer would, so every
// non-ASCII character becomes a `\uXXXX` escape — including each half of a
// surrogate pair, which is the escape a cut is most likely to split.
function asciiEscape(text: string): string {
  return text.replace(
    /[\u0080-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

// The one payload under three encodings every provider is entitled to send
const ENCODINGS: ReadonlyArray<readonly [string, string]> = [
  ['compact', JSON.stringify(ESCAPED_ARGS)],
  ['pretty-printed', JSON.stringify(ESCAPED_ARGS, null, 2)],
  ['ASCII-escaped', asciiEscape(JSON.stringify(ESCAPED_ARGS))],
]

describe('scanPartialJsonObject', () => {
  it('reads every top-level string field of a complete object', () => {
    const scan = scanPartialJsonObject(PAYLOAD)
    expect(scan.complete).toBe(true)
    expect(scan.streaming).toBeNull()
    expect(scan.fields.get('title')).toBe('The Descent')
    expect(scan.fields.get('body')).toBe(BODY)
  })

  it('reports no field of a non-object text', () => {
    for (const text of ['', '  ', 'null', '[1,2]', '"body"', 'not json at all']) {
      const scan = scanPartialJsonObject(text)
      expect(scan.fields.size).toBe(0)
      expect(scan.complete).toBe(false)
    }
  })

  it('reports an empty object as complete', () => {
    expect(scanPartialJsonObject('{}').complete).toBe(true)
    expect(scanPartialJsonObject('{ }').complete).toBe(true)
  })

  it('reports nothing yet for a prefix that ends inside or just after a key', () => {
    for (const text of ['{', '{"', '{"bod', '{"body"', '{"body":', '{"body": ']) {
      const scan = scanPartialJsonObject(text)
      expect(scan.fields.size).toBe(0)
      expect(scan.streaming).toBeNull()
      expect(scan.complete).toBe(false)
    }
  })

  it('reads the fields whichever order the keys arrive in', () => {
    const bodyFirst = scanPartialJsonObject('{"body":"Breathe in","title":"Induction"}')
    const titleFirst = scanPartialJsonObject('{"title":"Induction","body":"Breathe in"}')
    for (const scan of [bodyFirst, titleFirst]) {
      expect(scan.fields.get('title')).toBe('Induction')
      expect(scan.fields.get('body')).toBe('Breathe in')
      expect(scan.complete).toBe(true)
    }
  })

  it('never throws and only ever reports a prefix of the eventual value, at every byte offset', () => {
    for (let cut = 0; cut <= PAYLOAD.length; cut += 1) {
      const scan = scanPartialJsonObject(PAYLOAD.slice(0, cut))
      const title = scan.fields.get('title')
      const body = scan.fields.get('body')
      if (title !== undefined) expect('The Descent'.startsWith(title)).toBe(true)
      if (body !== undefined) expect(BODY.startsWith(body)).toBe(true)
      expect(scan.complete).toBe(cut === PAYLOAD.length)
    }
  })

  it('grows the streamed field monotonically as fragments arrive', () => {
    let previous = ''
    for (let cut = 0; cut <= PAYLOAD.length; cut += 1) {
      const body = scanPartialJsonObject(PAYLOAD.slice(0, cut)).fields.get('body') ?? ''
      expect(body.startsWith(previous)).toBe(true)
      previous = body
    }
    expect(previous).toBe(BODY)
  })

  it('names the field still arriving, and only while it is arriving', () => {
    expect(scanPartialJsonObject('{"title":"The De').streaming).toBe('title')
    expect(scanPartialJsonObject('{"title":"The Descent"').streaming).toBeNull()
    expect(scanPartialJsonObject('{"title":"The Descent","body":"Sett').streaming).toBe('body')
    expect(scanPartialJsonObject(PAYLOAD).streaming).toBeNull()
  })

  it('contributes nothing for an escape cut in half', () => {
    expect(scanPartialJsonObject('{"body":"line\\').fields.get('body')).toBe('line')
    expect(scanPartialJsonObject('{"body":"line\\n').fields.get('body')).toBe('line\n')
    expect(scanPartialJsonObject('{"body":"line\\u').fields.get('body')).toBe('line')
    expect(scanPartialJsonObject('{"body":"line\\u00').fields.get('body')).toBe('line')
    expect(scanPartialJsonObject('{"body":"line\\u0041').fields.get('body')).toBe('lineA')
  })

  it('decodes the escapes JSON.stringify produces', () => {
    const raw = JSON.stringify({ body: 'a\nb\tc"d\\ef' })
    expect(scanPartialJsonObject(raw).fields.get('body')).toBe('a\nb\tc"d\\ef')
  })

  it('keeps a malformed unicode escape as its digits rather than dropping the field', () => {
    expect(scanPartialJsonObject('{"body":"x\\uZZZZy"}').fields.get('body')).toBe('xZZZZy')
  })

  it('is not misled by braces, quotes, or the field name inside a value', () => {
    const tricky = JSON.stringify({
      body: 'she wrote {"body": "a decoy"} on the card',
      title: 'After the decoy',
    })
    const scan = scanPartialJsonObject(tricky)
    expect(scan.fields.get('body')).toBe('she wrote {"body": "a decoy"} on the card')
    expect(scan.fields.get('title')).toBe('After the decoy')
  })

  it('steps over a non-string value to reach a later string field', () => {
    const scan = scanPartialJsonObject('{"index":3,"nested":{"a":[1,{"b":"c"}]},"title":"Reached"}')
    expect(scan.fields.get('title')).toBe('Reached')
    expect(scan.fields.has('index')).toBe(false)
  })

  it('stops at a nested value the text cut in half', () => {
    const scan = scanPartialJsonObject('{"nested":{"a":[1,2')
    expect(scan.fields.size).toBe(0)
    expect(scan.complete).toBe(false)
  })

  it('withholds a trailing scalar that no delimiter has closed', () => {
    expect(scanPartialJsonObject('{"index":12').complete).toBe(false)
    expect(scanPartialJsonObject('{"index":12,"title":"Now"}').fields.get('title')).toBe('Now')
  })

  it('tolerates whitespace between every token', () => {
    const scan = scanPartialJsonObject('{\n  "title" : "Spaced" ,\n  "body" : "Out"\n}')
    expect(scan.fields.get('title')).toBe('Spaced')
    expect(scan.fields.get('body')).toBe('Out')
    expect(scan.complete).toBe(true)
  })

  // The prefix property is the real guarantee, but it only rules out leaked
  // escape syntax implicitly. A body that contains no backslash of its own
  // lets the failure be named outright: if a cut mid-escape ever surfaced `\`,
  // `\u` or its raw hex digits as prose, a backslash would appear here.
  it('never surfaces half-decoded escape syntax', () => {
    const plain = 'She said, "sink"\nand — dreamily\tso — you did.'
    const text = asciiEscape(JSON.stringify({ title: 'Induction', body: plain, index: 2 }))
    for (let cut = 0; cut <= text.length; cut += 1) {
      const body = scanPartialJsonObject(text.slice(0, cut)).fields.get('body')
      if (body === undefined) continue
      expect(body, `offset ${cut}`).toBe(plain.slice(0, body.length))
      expect(body.includes('\\'), `offset ${cut}: leaked escape syntax`).toBe(false)
    }
  })

  describe.each(ENCODINGS)('a %s payload truncated at every offset', (_name, text) => {
    const final = JSON.parse(text) as Record<string, unknown>

    it('encodes the body the reader has to survive', () => {
      expect(final).toEqual(ESCAPED_ARGS)
      expect(text).toContain('\\u')
      expect(text).toContain('\\n')
      expect(text).toContain('\\"')
    })

    it('never throws, and every field it reports is a prefix of the finished value', () => {
      for (let cut = 0; cut <= text.length; cut += 1) {
        const scan = scanPartialJsonObject(text.slice(0, cut))
        for (const [key, value] of scan.fields) {
          const finished = final[key]
          expect(typeof finished, `offset ${cut}: reported non-string field ${key}`).toBe('string')
          expect(
            (finished as string).startsWith(value),
            `offset ${cut}: ${key} reported ${JSON.stringify(value)}`,
          ).toBe(true)
        }
        expect(scan.complete, `offset ${cut}`).toBe(cut === text.length)
      }
    })

    it('reports a body that is exactly a prefix of the finished one at every cut', () => {
      for (let cut = 0; cut <= text.length; cut += 1) {
        const body = scanPartialJsonObject(text.slice(0, cut)).fields.get('body')
        if (body === undefined) continue
        expect(body, `offset ${cut}`).toBe(ESCAPED_BODY.slice(0, body.length))
      }
    })

    it('never retracts or rewrites text it has already reported', () => {
      const seen = new Map<string, string>()
      for (let cut = 0; cut <= text.length; cut += 1) {
        for (const [key, value] of scanPartialJsonObject(text.slice(0, cut)).fields) {
          const previous = seen.get(key) ?? ''
          expect(value.startsWith(previous), `offset ${cut}: ${key} went backwards`).toBe(true)
          seen.set(key, value)
        }
      }
      expect(seen.get('body')).toBe(ESCAPED_BODY)
      expect(seen.get('title')).toBe(ESCAPED_ARGS.title)
    })

    // A value whose closing quote has not arrived is still arriving even when
    // every character of it has, so the property is about the text being cut
    // open, not about the value being short.
    it('names a still-arriving field only while the text is cut open inside it', () => {
      for (let cut = 0; cut <= text.length; cut += 1) {
        const scan = scanPartialJsonObject(text.slice(0, cut))
        if (scan.streaming === null) continue
        expect(cut, 'the finished text reported a field as still arriving').toBeLessThan(text.length)
        expect(scan.fields.has(scan.streaming), `offset ${cut}: unreported field`).toBe(true)
        const keys = [...scan.fields.keys()]
        expect(keys[keys.length - 1], `offset ${cut}: not the last field`).toBe(scan.streaming)
        expect(scan.complete).toBe(false)
      }
    })
  })
})
