Migrating to Responses API (from https://platform.openai.com/docs/guides/migrate-to-responses)
==========================

The [Responses API](/docs/api-reference/responses) is a core agentic API primitive, combining the simplicity of [Chat Completions](/docs/api-reference/chat) with the ability to do more agentic tasks and express powerful reasoning.

While Chat Completions remains supported, Responses is recommended for all new projects.

About the Responses API
-----------------------

The Responses API is a unified interface for building powerful, agent-like applications. It contains:

*   Built-in tools like [web search](/docs/guides/tools-web-search), [file search](/docs/guides/tools-file-search) , [computer use](/docs/guides/tools-computer-use), [code interpreter](/docs/guides/tools-code-interpreter), and [remote MCPs](/docs/guides/tools-remote-mcp).
*   Seamless multi-turn interactions that allow you to pass previous responses for higher accuracy reasoning results.
*   Native multimodal support for text, images, and audio.

Responses benefits
------------------

The Responses API contains several benefits over Chat Completions:

*   **Stateful conversations**: Use store: true and previous\_response\_id to maintain context without resending the entire history.
*   **Encrypted reasoning**: Keep your workflow stateless while still benefiting from reasoning items.
*   **Built-in tools**: Add capabilities like web\_search\_preview, file\_search, and custom function calls directly in your request.
*   **Flexible inputs**: Pass a string with input or a list of messages; use instructions for system-level guidance.
*   **Better reasoning**: Results in better reasoning performance (3% improvement in SWE-benchmark with same prompt and setup compared to Chat Completions)
*   **Lower costs**: Results in lower costs due to improved cache utilization (40% to 80% improvementwhen compared to Chat Completions in internal tests).
*   **Future-proof**: Future-proofed for upcoming models.

Comparison to Chat Completions
------------------------------

The Responses API is a superset of the Chat Completions API. It has a predictable, event-driven architecture, whereas the Chat Completions API continuously appends to the content field as tokens are generated—requiring you to manually track differences between each state. Multi-step conversational logic and reasoning are easier to implement with the Responses API.

The Responses API clearly emits semantic events detailing precisely what changed (e.g., specific text additions), so you can write integrations targeted at specific emitted events (e.g., text changes), simplifying integration and improving type safety.

|Capabilities|Chat Completions API|Responses API|
|---|---|---|
|Text generation|||
|Audio||Coming soon|
|Vision|||
|Structured Outputs|||
|Function calling|||
|Web search|||
|File search|||
|Computer use|||
|Code interpreter|||
|MCP|||
|Image generation|||
|Reasoning summaries|||

### Difference examples

Both APIs make it easy to generate output from our models. A completion requires a `messages` array, but a response requires an `input` (string or array, as shown below).

Chat Completions API

```python
from openai import OpenAI
client = OpenAI()

completion = client.chat.completions.create(
  model="gpt-5",
  messages=[
      {
          "role": "user",
          "content": "Write a one-sentence bedtime story about a unicorn."
      }
  ]
)

print(completion.choices[0].message.content)
```

Responses API

```python
from openai import OpenAI
client = OpenAI()

response = client.responses.create(
  model="gpt-5",
  input=[
      {
          "role": "user",
          "content": "Write a one-sentence bedtime story about a unicorn."
      }
  ]
)

print(response.output_text)
```

When you get a response back from the Responses API, the fields differ slightly. Instead of a `message`, you receive a typed `response` object with its own `id`. Responses are stored by default. Chat completions are stored by default for new accounts. To disable storage when using either API, set `store: false`.

Chat Completions API

```json
[
{
  "index": 0,
  "message": {
    "role": "assistant",
    "content": "Under the soft glow of the moon, Luna the unicorn danced through fields of twinkling stardust, leaving trails of dreams for every child asleep.",
    "refusal": null
  },
  "logprobs": null,
  "finish_reason": "stop"
}
]
```

Responses API

```json
[
{
  "id": "msg_67b73f697ba4819183a15cc17d011509",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "output_text",
      "text": "Under the soft glow of the moon, Luna the unicorn danced through fields of twinkling stardust, leaving trails of dreams for every child asleep.",
      "annotations": []
    }
  ]
}
]
```

### Additional differences

*   [Reasoning](/docs/guides/reasoning) models have a richer experience in the Responses API with [improved tool usage](/docs/guides/reasoning#keeping-reasoning-items-in-context).
*   The Responses API returns `output`, while the Chat Completions API returns a `choices` array.
*   Structured Outputs API shape is different. Instead of `response_format`, use `text.format` in Responses. Learn more in the [Structured Outputs](/docs/guides/structured-outputs) guide.
*   Function calling API shape is different—both for the function config on the request and function calls sent back in the response. See the full difference in the [function calling guide](/docs/guides/function-calling).
*   The Responses SDK has an `output_text` helper, which the Chat Completions SDK does not have.
*   Conversation state: You have to manage conversation state yourself in Chat Completions, while Responses has `previous_response_id` to help you with long-running conversations.
*   Responses are stored by default. Chat completions are stored by default for new accounts. To disable storage, set `store: false`.

### Assistants API

Based on developer feedback from the [Assistants API](/docs/api-reference/assistants) beta, we've incorporated key improvements into the Responses API to make it more flexible, faster, and easier to use. The Responses API represents the future direction for building agents on OpenAI.

We now have Assistant-like and Thread-like objects in the Responses API. Learn more in the [migration guide](/docs/guides/assistants/migration). As of August 26th, 2025, we're deprecating the Assistants API, with a sunset date of August 26, 2026.

Migrating from Chat Completions
-------------------------------

### 1\. Update generation endpoints

Start by updating your generation endpoints from Chat Completions to Responses.

**Chat Completions**

With Chat Completions, you need to create an array of messages that specifify different roles and content for each role.

Generate text from a model

```javascript
import OpenAI from 'openai';
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
        model: 'gpt-5',
        messages: [
            { 'role': 'system', 'content': 'You are a helpful assistant.' },
            { 'role': 'user', 'content': 'Hello!' }
        ]
    });
    console.log(completion.choices[0].message.content);
```

```python
from openai import OpenAI
    client = OpenAI()

    completion = client.chat.completions.create(
        model="gpt-5",
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello!"}
        ]
    )
    print(completion.choices[0].message.content)
```

```bash
curl https://api.openai.com/v1/chat/completions     -H "Content-Type: application/json"     -H "Authorization: Bearer $OPENAI_API_KEY"     -d '{
        "model": "gpt-5",
        "messages": [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
        ]
    }'
```

**Responses**

With Responses, you can separate instructions and input at the top-level. The API shape is similar to Chat Completions but has cleaner semantics.

Generate text from a model

```javascript
import OpenAI from 'openai';
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.responses.create({
        model: 'gpt-5',
        instructions: 'You are a helpful assistant.',
        input: 'Hello!'
    });

    console.log(response.output_text);
```

```python
from openai import OpenAI
    client = OpenAI()

    response = client.responses.create(
        model="gpt-5",
        instructions="You are a helpful assistant.",
        input="Hello!"
    )
    print(response.output_text)
```

```bash
curl https://api.openai.com/v1/responses     -H "Content-Type: application/json"     -H "Authorization: Bearer $OPENAI_API_KEY"     -d '{
        "model": "gpt-5",
        "instructions": "You are a helpful assistant.",
        "input": "Hello!"
    }'
```

### 2\. Update multi-turn conversations

If you have multi-turn conversations in your application, update your context logic.

**Chat Completions**

In Chat Completions, you have to store and manage context yourself.

Multi-turn conversation

```javascript
let messages = [
        { 'role': 'system', 'content': 'You are a helpful assistant.' },
        { 'role': 'user', 'content': 'What is the capital of France?' }
        ];
    const res1 = await client.chat.completions.create({
        model: 'gpt-5',
        messages
    });
    
    messages.push({ 'role': 'assistant', 'content': res1.choices[0].message.content });
    messages.push({ 'role': 'user', 'content': 'And its population?' });
    
    const res2 = await client.chat.completions.create({
        model: 'gpt-5',
        messages
    });
```

```python
messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the capital of France?"}
    ]
    res1 = client.chat.completions.create(model="gpt-5", messages=messages)
    
    messages.append({"role": "assistant", "content": res1.choices[0].message.content})
    messages.append({"role": "user", "content": "And its population?"})

    res2 = client.chat.completions.create(model="gpt-5", messages=messages)
```

**Responses**

With Responses, you no longer need to manage context yourself. Simply pass the previous response ID to the next API call and the model will automatically utilize relevant previous context.

Multi-turn conversation

```javascript
const res1 = await client.responses.create({
        model: 'gpt-5',
        input: 'What is the capital of France?',
        store: true
    });

    const res2 = await client.responses.create({
        model: 'gpt-5',
        input: 'And its population?',
        previous_response_id: res1.id,
        store: true
    });
```

```python
res1 = client.responses.create(
        model="gpt-5",
        input="What is the capital of France?",
        store=True
    )
    
    res2 = client.responses.create(
        model="gpt-5",
        input="And its population?",
        previous_response_id=res1.id,
        store=True
    )
```

Some organizations—such as those with Zero Data Retention (ZDR) requirements—cannot use the Responses API in a stateful way due to compliance or data retention policies. To support these cases, OpenAI offers encrypted reasoning items, allowing you to keep your workflow stateless while still benefiting from reasoning items.

To use encrypted reasoning items:

*   add `["reasoning.encrypted_content"]` to the [include field](/docs/api-reference/responses/create#responses_create-include)
*   set `store==false` in the [store field](/docs/api-reference/responses/create#responses_create-store)

The API will then return an encrypted version of the reasoning tokens, which you can pass back in future requests just like regular reasoning items. For ZDR organizations, OpenAI enforces store=false automatically. When a request includes encrypted\_content, it is decrypted in-memory (never written to disk), used for generating the next response, and then securely discarded. Any new reasoning tokens are immediately encrypted and returned to you, ensuring no intermediate state is ever persisted.

For ZDR organizations, OpenAI enforces store=false automatically. When a request includes encrypted\_content, it is decrypted in-memory (never written to disk), used for generating the next response, and then securely discarded. Any new reasoning tokens are immediately encrypted and returned to you, ensuring no intermediate state is ever persisted.

### 3\. Update tools usage

If your application has use cases that would benefit from OpenAI's native [tools](/docs/guides/tools), you can update your tool calls to use OpenAI's tools out of the box.

**Chat Completions**

With Chat Completions, you cannot use OpenAI's tools natively and have to write your own.

Web search tool

```javascript
async function web_search(query) {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`https://api.example.com/search?q=${query}`);
    const data = await res.json();
    return data.results;
}

const completion = await client.chat.completions.create({
  model: 'gpt-5',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Who is the current president of France?' }
  ],
  functions: [
    {
      name: 'web_search',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  ]
});
```

```python
import requests

def web_search(query):
    r = requests.get(f"https://api.example.com/search?q={query}")
    return r.json().get("results", [])

completion = client.chat.completions.create(
    model="gpt-5",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Who is the current president of France?"}
    ],
    functions=[
        {
            "name": "web_search",
            "description": "Search the web for information",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"]
            }
        }
    ]
)
```

```bash
curl https://api.example.com/search   -G   --data-urlencode "q=your+search+term"   --data-urlencode "key=$SEARCH_API_KEY"
```

**Responses**

With Responses, you can simply specify the tools that you are interested in.

Web search tool

```javascript
const answer = await client.responses.create({
        model: 'gpt-5',
        input: 'Who is the current president of France?',
        tools: [{ type: 'web_search_preview' }]
    });
    console.log(answer.output_text);
```

```python
answer = client.responses.create(
    model="gpt-5",
    input="Who is the current president of France?",
    tools=[{"type": "web_search_preview"}]
)
print(answer.output_text)
```

```bash
curl https://api.openai.com/v1/responses   -H "Content-Type: application/json"   -H "Authorization: Bearer $OPENAI_API_KEY"   -d '{
    "model": "gpt-5",
    "input": "Who is the current president of France?",
    "tools": [{"type": "web_search_preview"}]
  }'
```

Incremental migration
---------------------

The Responses API is a superset of the Chat Completions API. The Chat Completions API will also continue to be supported. As such, you can incrementally adopt the Responses API if desired. You can migrate user flows who would benefit from improved reasoning models to the Responses API while keeping other flows on the Chat Completions API until you're ready for a full migration.

As a best practice, we encourage all users to migrate to the Responses API to take advantage of the latest features and improvements from OpenAI.
