/**
 * End-to-end smoke test for the headless agents API.
 *
 * This fork has no test suite; this script is the regression check. It
 * exercises every endpoint the Angular client uses, including a real chat
 * round trip (job start -> SSE stream -> final event). Run it against a
 * live backend after any change:
 *
 *   npm run smoke                          # against http://localhost:3080
 *   SMOKE_BASE_URL=https://... npm run smoke
 *
 * A provider API key (e.g. OPENAI_API_KEY) must be configured server-side
 * for the chat step to reach a `final` event; without one the step still
 * passes if the stream delivers a provider-level error event.
 */
const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3080';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const results = [];
let failures = 0;

async function step(name, fn) {
  try {
    const out = await fn();
    results.push(`PASS  ${name}${out ? ' — ' + out : ''}`);
  } catch (err) {
    failures++;
    results.push(`FAIL  ${name} — ${err.message}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

await step('login route is gone (404)', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({}),
  });
  if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
  return '404 as expected';
});

await step('GET /api/agents/', async () => {
  const res = await req('GET', '/api/agents/');
  return `${res.data?.length ?? 0} agents`;
});

await step('GET /api/models', async () => {
  const res = await req('GET', '/api/models');
  return `providers: ${Object.keys(res).join(', ') || '(none)'}`;
});

await step('GET /api/endpoints', async () => {
  const res = await req('GET', '/api/endpoints');
  return `endpoints: ${Object.keys(res).join(', ')}`;
});

await step('GET /api/categories', async () => {
  const res = await req('GET', '/api/categories');
  return `${Array.isArray(res) ? res.length : '?'} categories`;
});

let existingConvoId = '';
await step('GET /api/convos', async () => {
  const res = await req('GET', '/api/convos');
  const items = Array.isArray(res) ? res : (res.conversations ?? res.data ?? []);
  existingConvoId = items[0]?.conversationId ?? '';
  return `${items.length} conversations`;
});

let agentId = '';
await step('POST /api/agents (create)', async () => {
  const res = await req('POST', '/api/agents', {
    name: 'Smoke Test Agent',
    description: 'created by scripts/smoke.mjs',
    provider: 'openAI',
    model: 'gpt-4o-mini',
    model_parameters: { temperature: 0.5, max_output_tokens: null, top_p: null },
  });
  if (!res.id) throw new Error('no agent id');
  agentId = res.id;
  return `id=${agentId}`;
});

if (agentId) {
  await step('GET /api/agents/:id', async () => {
    const res = await req('GET', `/api/agents/${agentId}`);
    return `name=${res.name}, provider=${res.provider}, model=${res.model}`;
  });

  await step('PATCH /api/agents/:id', async () => {
    const res = await req('PATCH', `/api/agents/${agentId}`, {
      description: 'updated by smoke test',
    });
    return `description=${res.description}`;
  });

  await step('GET /api/agents/actions', async () => {
    const res = await req('GET', '/api/agents/actions');
    return `${Array.isArray(res) ? res.length : '?'} actions`;
  });

  await step('POST /api/agents/chat + SSE stream', async () => {
    const start = await req('POST', '/api/agents/chat', {
      endpoint: 'agents',
      agent_id: agentId,
      text: 'Say OK and nothing else. Do not use tools.',
      messageId: crypto.randomUUID(),
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      conversationId: null,
      isContinued: false,
    });
    if (!start.streamId) throw new Error(`no streamId: ${JSON.stringify(start).slice(0, 120)}`);

    const streamRes = await fetch(`${BASE}/api/agents/chat/stream/${start.streamId}`, {
      headers: { Accept: 'text/event-stream', 'User-Agent': UA },
    });
    if (!streamRes.ok || !streamRes.body) throw new Error(`stream ${streamRes.status}`);

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let events = 0;
    let outcome = '';
    const deadline = Date.now() + 60_000;
    read: while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        events++;
        let d;
        try {
          d = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }
        if (d.final) {
          outcome = 'final event received';
          break read;
        }
        if (d.error) {
          outcome = `provider error event: ${JSON.stringify(d.error).slice(0, 80)}`;
          break read;
        }
      }
    }
    reader.cancel().catch(() => {});
    if (!outcome) throw new Error(`stream ended without final/error after ${events} events`);
    return `${events} SSE events, ${outcome}`;
  });

  await step('DELETE /api/agents/:id', async () => {
    await req('DELETE', `/api/agents/${agentId}`);
    return 'deleted';
  });
}

await step('GET /api/messages/:conversationId', async () => {
  if (!existingConvoId) return 'skipped — no existing conversation';
  const res = await req('GET', `/api/messages/${existingConvoId}`);
  const items = Array.isArray(res) ? res : (res.messages ?? []);
  return `${items.length} messages in convo ${existingConvoId.slice(0, 8)}…`;
});

console.log(results.join('\n'));
if (failures > 0) {
  console.log(`\n${failures} step(s) failed`);
  process.exit(1);
}
console.log('\nAll steps passed');
