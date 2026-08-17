import assert from 'node:assert/strict';
import test from 'node:test';
import { streamAiChat, type AiSource } from '../src/ai.ts';
import type { ClientSession } from '../src/http.ts';

const conversationId = '018f17ac-4e99-7ec5-b4fd-8f15ca9f4f12';
const modelId = '018f17ac-4e99-7ec5-b4fd-8f15ca9f4f11';

test('buffers a finite native SSE response and dispatches every event', async () => {
  let requestBody = '';
  const seen: string[] = [];
  let sources: AiSource[] = [];
  const session = client(async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return sse([
      ': keep-alive\r\n\r\n',
      `event: conversation\r\ndata: {"Id":"${conversationId}"}\r\n\r\n`,
      'event: tool\ndata: {"Label":"Searching"}\n\n',
      'event: delta\ndata: {"Text":"Try Arrival."}\n\n',
      'event: sources\ndata: {"Items":[{"Id":"item-1","Name":"Arrival","Type":"Movie","ProductionYear":2016}]}\n\n',
      `event: done\ndata: {"ConversationId":"${conversationId}"}\n\n`,
    ].join(''));
  });

  await streamAiChat(session, {
    conversationId: null,
    newConversationId: conversationId,
    modelId,
    message: 'Recommend a film',
  }, {
    onConversation: (id) => { seen.push(`conversation:${id}`); },
    onTool: (label) => { seen.push(`tool:${label}`); },
    onDelta: (value) => { seen.push(`delta:${value}`); },
    onSources: (value) => { sources = value; },
    onDone: (id) => { seen.push(`done:${id}`); },
  });

  assert.deepEqual(JSON.parse(requestBody), {
    ModelId: modelId,
    Message: 'Recommend a film',
    NewConversationId: conversationId,
  });
  assert.deepEqual(seen, [
    `conversation:${conversationId}`,
    'tool:Searching',
    'delta:Try Arrival.',
    `done:${conversationId}`,
  ]);
  assert.deepEqual(sources, [{
    id: 'item-1', name: 'Arrival', type: 'Movie', productionYear: 2016,
  }]);
});

test('rejects malformed, unterminated, and non-SSE responses', async () => {
  for (const response of [
    sse('event: delta\ndata: {"Text":"unfinished"}\n\n'),
    sse('event: done\ndata: {}\n\n'),
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ]) {
    await assert.rejects(
      streamAiChat(client(async () => response), {
        conversationId: null,
        newConversationId: conversationId,
        modelId,
        message: 'Film',
      }, {}),
      { kind: 'invalid-response' },
    );
  }
});

test('maps HTTP errors before reading the event stream', async () => {
  await assert.rejects(
    streamAiChat(client(async () => sse('', 401)), {
      conversationId: null,
      newConversationId: conversationId,
      modelId,
      message: 'Film',
    }, {}),
    { kind: 'authentication', status: 401 },
  );
});

test('requires exactly one conversation id before sending', async () => {
  let called = false;
  const session = client(async () => {
    called = true;
    return sse('');
  });
  await assert.rejects(streamAiChat(session, {
    conversationId: null, newConversationId: null, modelId, message: 'Film',
  }, {}), { kind: 'validation' });
  await assert.rejects(streamAiChat(session, {
    conversationId, newConversationId: conversationId, modelId, message: 'Film',
  }, {}), { kind: 'validation' });
  assert.equal(called, false);
});

function client(fetch: NonNullable<ClientSession['fetch']>): ClientSession {
  return {
    baseUrl: 'https://example.test', token: 'token', deviceId: 'device',
    clientName: 'test', deviceName: 'test', eventStreamMode: 'buffered', fetch,
  };
}

function sse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
