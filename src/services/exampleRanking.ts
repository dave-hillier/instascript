import { estimateTokenCount } from '../utils/contextWindow'

// Hand-rolled lexical ranking (BM25) and diversity-aware selection (MMR) for
// the local example corpus. The corpus is tens-to-hundreds of documents, so
// brute-force scoring on every query is deliberate — no index, no dependency.

export interface RankableExample {
  id: string
  title: string
  tags: string[]
  content: string
  embedding?: number[]
}

export interface RankedExample<T extends RankableExample> {
  example: T
  score: number
}

export interface SelectionOptions {
  limit: number
  tokenBudget?: number
  lambda?: number
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'have', 'i', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no',
  'not', 'of', 'on', 'or', 'so', 'that', 'the', 'their', 'them', 'they',
  'this', 'to', 'was', 'we', 'were', 'will', 'with', 'you', 'your'
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(token => token.length > 1 && !STOPWORDS.has(token))
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const TITLE_WEIGHT = 3
const TAG_WEIGHT = 3

interface IndexedDocument {
  termFrequencies: Map<string, number>
  length: number
  tokenSet: Set<string>
}

// Title and tag tokens are boosted by counting them multiple times, so a
// query term matching the title or a tag outweighs a passing body mention
function indexExample(example: RankableExample): IndexedDocument {
  const termFrequencies = new Map<string, number>()
  let length = 0

  const addTokens = (tokens: string[], weight: number) => {
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight)
      length += weight
    }
  }

  addTokens(tokenize(example.title), TITLE_WEIGHT)
  addTokens(example.tags.flatMap(tag => tokenize(tag)), TAG_WEIGHT)
  addTokens(tokenize(example.content), 1)

  return { termFrequencies, length, tokenSet: new Set(termFrequencies.keys()) }
}

// BM25 relevance ranking of every example against the query. All examples are
// returned (zero scorers last, original order preserved among ties) so callers
// can still fill their example slots when the query matches nothing.
export function rankExamples<T extends RankableExample>(
  query: string,
  examples: T[]
): RankedExample<T>[] {
  const queryTerms = [...new Set(tokenize(query))]
  const documents = examples.map(indexExample)
  const documentCount = documents.length

  if (documentCount === 0) return []

  const averageLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) / documentCount || 1

  const scores = documents.map(doc => {
    let score = 0
    for (const term of queryTerms) {
      const frequency = doc.termFrequencies.get(term)
      if (!frequency) continue

      const documentsWithTerm = documents.reduce(
        (count, other) => count + (other.termFrequencies.has(term) ? 1 : 0),
        0
      )
      const idf = Math.log(
        1 + (documentCount - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5)
      )
      const normalizedFrequency =
        (frequency * (BM25_K1 + 1)) /
        (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / averageLength)))

      score += idf * normalizedFrequency
    }
    return score
  })

  return examples
    .map((example, index) => ({ example, score: scores[index] }))
    .sort((a, b) => b.score - a.score)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

// Dense ranking by cosine similarity between the query embedding and each
// example's stored embedding. Examples without an embedding are omitted —
// they still reach the final ranking through the lexical list, so a corpus
// with partial embedding coverage keeps working.
export function rankExamplesByEmbedding<T extends RankableExample>(
  queryEmbedding: number[],
  examples: T[]
): RankedExample<T>[] {
  return examples
    .filter(example => example.embedding && example.embedding.length > 0)
    .map(example => ({
      example,
      score: cosineSimilarity(queryEmbedding, example.embedding!)
    }))
    .sort((a, b) => b.score - a.score)
}

const RRF_K = 60

// Reciprocal rank fusion: each list contributes 1 / (k + rank) per document,
// so agreement between lexical and dense signals compounds while a document
// missing from one list (e.g. no stored embedding) still scores from the
// other. With a single list this is a monotone rescoring — order preserved —
// which is exactly the graceful degradation the hybrid retrieval needs.
export function fuseRankings<T extends RankableExample>(
  rankings: RankedExample<T>[][]
): RankedExample<T>[] {
  const fused = new Map<string, { example: T; score: number; firstSeen: number }>()
  let order = 0

  for (const ranking of rankings) {
    ranking.forEach(({ example }, rank) => {
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = fused.get(example.id)
      if (existing) {
        existing.score += contribution
      } else {
        fused.set(example.id, { example, score: contribution, firstSeen: order++ })
      }
    })
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen)
    .map(({ example, score }) => ({ example, score }))
}

// Jaccard similarity over the documents' token sets — cheap, symmetric, and
// close to 1 for near-duplicate scripts
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// Candidates at least this similar to an already-selected example are treated
// as near-duplicates and excluded outright — a variant of the same script
// teaches the model nothing a second slot should pay for
const DUPLICATE_SIMILARITY_THRESHOLD = 0.8

// Greedy maximal-marginal-relevance selection under a token budget: each pick
// maximizes lambda * relevance - (1 - lambda) * similarity-to-already-selected,
// near-duplicates of selected examples are dropped entirely, and candidates
// whose actual size exceeds the remaining budget are skipped.
export function selectDiverseExamples<T extends RankableExample>(
  ranked: RankedExample<T>[],
  options: SelectionOptions
): RankedExample<T>[] {
  const { limit, tokenBudget = Infinity, lambda = 0.7 } = options
  if (limit <= 0 || ranked.length === 0) return []

  const maxScore = Math.max(...ranked.map(entry => entry.score), 0)
  const candidates = ranked.map(entry => ({
    entry,
    relevance: maxScore > 0 ? entry.score / maxScore : 0,
    tokens: estimateTokenCount(entry.example.content),
    tokenSet: indexExample(entry.example).tokenSet
  }))

  const selected: typeof candidates = []
  let remainingBudget = tokenBudget

  while (selected.length < limit) {
    let best: (typeof candidates)[number] | null = null
    let bestScore = -Infinity

    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue
      if (candidate.tokens > remainingBudget) continue

      const maxSimilarity = selected.reduce(
        (max, chosen) =>
          Math.max(max, jaccardSimilarity(candidate.tokenSet, chosen.tokenSet)),
        0
      )
      if (maxSimilarity >= DUPLICATE_SIMILARITY_THRESHOLD) continue

      const mmrScore = lambda * candidate.relevance - (1 - lambda) * maxSimilarity

      if (mmrScore > bestScore) {
        bestScore = mmrScore
        best = candidate
      }
    }

    if (!best) break

    selected.push(best)
    remainingBudget -= best.tokens
  }

  return selected.map(candidate => candidate.entry)
}
