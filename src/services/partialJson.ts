// A tolerant incremental reader for the top-level string fields of a JSON
// object that has only partially arrived.
//
// Tool call arguments reach us as a stream of argument-string deltas
// concatenated into one raw string, so a section body is readable long before
// the call is complete — but only by a reader that accepts a prefix cut at an
// arbitrary character, including inside a string, inside a backslash escape,
// or inside a `\uXXXX` sequence. `JSON.parse` rejects every such prefix.
//
// Guarantees, for any prefix P of a well-formed JSON object text T: scanning P
// never throws, and each value it reports for a field is a prefix of the value
// `JSON.parse(T)` gives that field. Scanning T itself reports every top-level
// string field with its exact value and `complete` set.

// What a scan recovered from one partially received JSON object text
export interface PartialJsonScan {
  // Decoded values of the top-level string fields seen so far, in arrival
  // order. The last entry is truncated when `streaming` names it.
  readonly fields: ReadonlyMap<string, string>
  // Name of the field whose string value was still arriving when the text ran
  // out, or null when the text ended on a value boundary
  readonly streaming: string | null
  // Whether the object's closing brace was reached
  readonly complete: boolean
}

// One decoded string and where it ended
interface StringRead {
  value: string
  // Index just past the closing quote, or the length of the text when cut
  end: number
  closed: boolean
}

const HEX = /^[0-9a-fA-F]{4}$/

// Decode a JSON string literal starting at an opening quote, stopping at the
// end of the available text.
//
// A trailing incomplete escape contributes nothing: `"ab\` and `"ab\u00` both
// decode to `ab`, so the reported value stays a prefix of the eventual one
// instead of leaking escape syntax into rendered prose.
function readString(raw: string, start: number): StringRead {
  let out = ''
  let index = start + 1
  while (index < raw.length) {
    const char = raw[index]
    if (char === '"') return { value: out, end: index + 1, closed: true }
    if (char !== '\\') {
      out += char
      index += 1
      continue
    }
    const escape = raw[index + 1]
    if (escape === undefined) break
    if (escape === 'u') {
      const digits = raw.slice(index + 2, index + 6)
      if (digits.length < 4) break
      if (!HEX.test(digits)) {
        // Tolerate a malformed escape rather than abandoning the field: a
        // reading view showing slightly wrong glyphs beats showing nothing.
        out += digits
        index += 6
        continue
      }
      out += String.fromCharCode(Number.parseInt(digits, 16))
      index += 6
      continue
    }
    switch (escape) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case '/': out += '/'; break
      default: out += escape; break
    }
    index += 2
  }
  return { value: out, end: raw.length, closed: false }
}

// Advance past a non-string value, balancing nested objects and arrays and
// ignoring braces that occur inside their strings. Returns the index just past
// the value, or -1 when the text ran out inside it.
function skipValue(raw: string, start: number): number {
  const first = raw[start]
  if (first === '"') {
    const read = readString(raw, start)
    return read.closed ? read.end : -1
  }
  if (first === '{' || first === '[') {
    let depth = 0
    let index = start
    while (index < raw.length) {
      const char = raw[index]
      if (char === '"') {
        const read = readString(raw, index)
        if (!read.closed) return -1
        index = read.end
        continue
      }
      if (char === '{' || char === '[') depth += 1
      else if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) return index + 1
      }
      index += 1
    }
    return -1
  }
  // A literal or number: only a following delimiter proves it arrived whole.
  let index = start
  while (index < raw.length && !',}] \t\r\n'.includes(raw[index] as string)) index += 1
  return index < raw.length ? index : -1
}

// Skip insignificant whitespace, returning the index of the next significant
// character or the text length
function skipSpace(raw: string, start: number): number {
  let index = start
  while (index < raw.length && ' \t\r\n'.includes(raw[index] as string)) index += 1
  return index
}

// Read the top-level string fields of a JSON object text that may be cut off
// at any point.
//
// Only top-level strings are reported; other values are stepped over so a
// later string field is still reached. Text that is not an object, or whose
// first key is malformed, yields an empty scan rather than an error.
export function scanPartialJsonObject(raw: string): PartialJsonScan {
  const fields = new Map<string, string>()
  let index = skipSpace(raw, 0)
  if (raw[index] !== '{') return { fields, streaming: null, complete: false }
  index = skipSpace(raw, index + 1)
  if (raw[index] === '}') return { fields, streaming: null, complete: true }
  while (index < raw.length) {
    if (raw[index] !== '"') break
    const key = readString(raw, index)
    if (!key.closed) break
    index = skipSpace(raw, key.end)
    if (raw[index] !== ':') break
    index = skipSpace(raw, index + 1)
    if (index >= raw.length) break
    if (raw[index] === '"') {
      const value = readString(raw, index)
      fields.set(key.value, value.value)
      if (!value.closed) return { fields, streaming: key.value, complete: false }
      index = value.end
    } else {
      const end = skipValue(raw, index)
      if (end === -1) break
      index = end
    }
    index = skipSpace(raw, index)
    if (raw[index] === ',') {
      index = skipSpace(raw, index + 1)
      continue
    }
    if (raw[index] === '}') return { fields, streaming: null, complete: true }
    break
  }
  return { fields, streaming: null, complete: false }
}
