import OpenAI from 'openai';

export interface ExampleScript {
  content: string
  metadata?: Record<string, string | number>
  score?: number
}

export interface SearchResult {
  content: string;
  score: number;
  filename?: string;
}

export type ContentType = 'markdown' | 'outline' | 'brief';

export async function performVectorSearch(
  openai: OpenAI,
  storeId: string,
  query: string,
  limit: number = 5,
  contentType?: ContentType
): Promise<SearchResult[]> {
  try {
    const searchOptions: {
      query: string;
      max_num_results: number;
      rewrite_query: boolean;
      ranking_options: { ranker: 'default-2024-11-15' };
      filters?: { type: 'eq'; key: string; value: string };
    } = {
      query,
      max_num_results: Math.min(limit, 20),
      rewrite_query: true,
      ranking_options: {
        ranker: 'default-2024-11-15'
      }
    };

    // Add attribute filtering if contentType is specified
    if (contentType) {
      searchOptions.filters = {
        type: 'eq',
        key: 'type',
        value: contentType
      };
    }

    const searchResponse = await openai.vectorStores.search(storeId, searchOptions);

    const results: SearchResult[] = [];
    
    for (const [index, result] of searchResponse.data.entries()) {
      if (index >= limit) break;
      
      const combinedContent = result.content.map(chunk => chunk.text).join('\n');
      results.push({
        content: combinedContent,
        score: result.score || 0,
        filename: result.filename
      });
    }
    
    return results;
  } catch (error) {
    console.error('Vector search error', error);
    return [];
  }
}

export async function findVectorStoreByName(openai: OpenAI, storeName: string): Promise<string | null> {
  try {
    const stores = await openai.vectorStores.list();
    const store = stores.data.find(s => s.name === storeName);
    return store?.id || null;
  } catch (error) {
    console.error('Error finding vector store', error);
    return null;
  }
}

export class VectorStoreService {
  private client: OpenAI
  private storeId: string | null = null
  private readonly storeName = 'hypno-default'

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true
    })
  }

  /**
   * Initialize vector store connection by finding the store ID
   */
  private async initializeStore(): Promise<string | null> {
    if (this.storeId) {
      return this.storeId
    }

    this.storeId = await findVectorStoreByName(this.client, this.storeName)
    if (!this.storeId) {
      console.warn(`Vector store '${this.storeName}' not found`)
    } else {
      console.debug('Vector store connected', this.storeName)
    }
    
    return this.storeId
  }

  /**
   * Search for relevant example scripts in the vector store
   * @param query User's prompt/query
   * @param limit Maximum number of examples to retrieve
   * @returns Array of relevant example scripts
   */
  async searchExamples(query: string, limit: number = 3): Promise<ExampleScript[]> {
    try {
      const storeId = await this.initializeStore()
      if (!storeId) {
        console.warn('No vector store available, returning empty results')
        return []
      }

      // Performing vector search

      const searchResults = await performVectorSearch(this.client, storeId, query, limit, 'markdown')
      
      // Convert SearchResult[] to ExampleScript[]
      const examples: ExampleScript[] = searchResults.map(result => ({
        content: result.content,
        score: result.score,
        metadata: {
          filename: result.filename || 'unknown',
          score: result.score
        }
      }))

      console.debug(`Found ${examples.length} examples:`, examples.map(e => ({ filename: e.metadata?.filename, score: e.score })))
      return examples
    } catch (error) {
      console.error('Vector store search failed', error)
      return []
    }
  }

  /**
   * Format examples for inclusion in prompts
   */
  static formatExamplesForPrompt(examples: ExampleScript[]): string {
    if (examples.length === 0) {
      return ''
    }

    let formatted = '\n\nHere are some example hypnosis scripts for reference:\n\n'
    
    examples.forEach((example, index) => {
      formatted += `### Example ${index + 1}\n`
      formatted += `${example.content}\n\n---\n\n`
    })

    formatted += 'Use these examples as inspiration for structure, language patterns, and therapeutic approaches. Create a new script that follows similar quality and format while being unique and tailored to the user\'s specific request.\n\n'

    return formatted
  }
}