import { ClientApiError, clientErrorKind, clientFetch, clientRequest, type ClientSession } from './http.ts';

export interface AiModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface AiSource {
  id: string;
  name: string;
  type: string;
  productionYear: number | null;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: AiSource[];
  createdAt: string;
}

export interface AiConversationSummary {
  id: string;
  modelId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversation extends AiConversationSummary {
  messages: AiMessage[];
}

export interface AiChatHandlers {
  onConversation?: (conversationId: string) => void;
  onTool?: (label: string) => void;
  onDelta?: (text: string) => void;
  onSources?: (items: AiSource[]) => void;
  onDone?: (conversationId: string) => void;
  onError?: () => void;
}

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;

export async function getAiModels(session: ClientSession): Promise<AiModel[]> {
  const value = await clientRequest<{ Items?: Array<{ Id: string; DisplayName: string; IsDefault?: boolean }> }>(
    session,
    '/Ai/Models',
  );
  return (value.Items ?? []).map((item) => ({
    id: item.Id,
    displayName: item.DisplayName,
    isDefault: item.IsDefault === true,
  }));
}

export async function listAiConversations(session: ClientSession): Promise<AiConversationSummary[]> {
  const value = await clientRequest<{ Items?: Array<{
    Id: string;
    ModelId: string;
    Title: string;
    CreatedAt: string;
    UpdatedAt: string;
  }> }>(session, '/Ai/Conversations');
  return (value.Items ?? []).map((item) => ({
    id: item.Id,
    modelId: item.ModelId,
    title: item.Title,
    createdAt: item.CreatedAt,
    updatedAt: item.UpdatedAt,
  }));
}

export async function getAiConversation(session: ClientSession, id: string): Promise<AiConversation> {
  const value = await clientRequest<{
    Id: string;
    ModelId: string;
    Title: string;
    CreatedAt: string;
    UpdatedAt: string;
    Messages?: Array<{
      Id: string;
      Role: 'user' | 'assistant';
      Content: string;
      Sources?: Array<{ Id: string; Name: string; Type: string; ProductionYear: number | null }>;
      CreatedAt: string;
    }>;
  }>(session, `/Ai/Conversations/${id}`);
  return {
    id: value.Id,
    modelId: value.ModelId,
    title: value.Title,
    createdAt: value.CreatedAt,
    updatedAt: value.UpdatedAt,
    messages: (value.Messages ?? []).map((message) => ({
      id: message.Id,
      role: message.Role,
      content: message.Content,
      sources: (message.Sources ?? []).map((source) => ({
        id: source.Id,
        name: source.Name,
        type: source.Type,
        productionYear: source.ProductionYear,
      })),
      createdAt: message.CreatedAt,
    })),
  };
}

export async function deleteAiConversation(session: ClientSession, id: string): Promise<void> {
  await clientRequest(session, `/Ai/Conversations/${id}`, { method: 'DELETE' });
}

export async function streamAiChat(
  session: ClientSession,
  request: {
    conversationId: string | null;
    newConversationId: string | null;
    modelId: string;
    message: string;
  },
  handlers: AiChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  if ((request.conversationId === null) === (request.newConversationId === null)) {
    throw new ClientApiError(400, 'validation');
  }
  const message = request.message.trim();
  if (!message || message.length > 16_000) throw new ClientApiError(400, 'validation');
  const payload: Record<string, unknown> = { ModelId: request.modelId, Message: message };
  if (request.conversationId) payload.ConversationId = request.conversationId;
  if (request.newConversationId) payload.NewConversationId = request.newConversationId;
  const parser = new SseParser(handlers);
  const response = await clientFetch(session, '/Ai/Chat', {
    method: 'POST',
    headers: { Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw new ClientApiError(response.status, clientErrorKind(response.status));
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'text/event-stream') throw new ClientApiError(response.status, 'invalid-response');

  // Expo's native Response body controller can race response.text(). Mobile opts into
  // the buffered path explicitly because the TJXY server always closes this SSE response.
  const buffered = session.eventStreamMode === 'buffered'
    || (session.eventStreamMode === undefined && isReactNative());
  if (buffered) {
    const text = await response.text();
    if (utf8ByteLength(text) > MAX_STREAM_BYTES) throw invalidResponse();
    parser.push(text, true);
    return;
  }

  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > MAX_STREAM_BYTES) throw invalidResponse();
    parser.push(decoder.decode(value, { stream: true }), false);
  }
  parser.push(decoder.decode(), true);
}

function isReactNative(): boolean {
  return typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
}

class SseParser {
  buffer = '';
  terminal = false;
  handlers: AiChatHandlers;

  constructor(handlers: AiChatHandlers) {
    this.handlers = handlers;
  }

  push(chunk: string, ended: boolean) {
    this.buffer += chunk.replaceAll('\r\n', '\n');
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (utf8ByteLength(frame) > MAX_FRAME_BYTES) throw invalidResponse();
      if (frame.trim().length > 0) this.terminal = dispatchFrame(frame, this.terminal, this.handlers);
      boundary = this.buffer.indexOf('\n\n');
    }
    if (ended) {
      if (this.buffer.trim().length > 0) {
        if (utf8ByteLength(this.buffer) > MAX_FRAME_BYTES) throw invalidResponse();
        this.terminal = dispatchFrame(this.buffer, this.terminal, this.handlers);
        this.buffer = '';
      }
      if (!this.terminal) throw new ClientApiError(0, 'invalid-response');
    }
  }
}

function dispatchFrame(frame: string, terminal: boolean, handlers: AiChatHandlers): boolean {
  const lines = frame.split('\n');
  if (lines.every((line) => !line || line.startsWith(':'))) return terminal;
  if (terminal) throw invalidResponse();
  const eventLines = lines.filter((line) => line.startsWith('event:'));
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  const unknownLines = lines.filter((line) => line && !line.startsWith(':') && !line.startsWith('event:') && !line.startsWith('data:'));
  if (eventLines.length !== 1 || dataLines.length !== 1 || unknownLines.length > 0) throw invalidResponse();
  const name = eventLines[0]?.slice(6).trim();
  let payload: unknown;
  try { payload = JSON.parse(dataLines[0]?.slice(5).trim() ?? ''); } catch { throw invalidResponse(); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidResponse();
  const data = payload as Record<string, unknown>;
  switch (name) {
    case 'conversation':
      if (typeof data.Id !== 'string') throw invalidResponse();
      handlers.onConversation?.(data.Id);
      return false;
    case 'tool':
      if (typeof data.Label !== 'string') throw invalidResponse();
      handlers.onTool?.(data.Label);
      return false;
    case 'delta':
      if (typeof data.Text !== 'string') throw invalidResponse();
      handlers.onDelta?.(data.Text);
      return false;
    case 'sources':
      if (!Array.isArray(data.Items)) throw invalidResponse();
      handlers.onSources?.(data.Items.map(parseSource));
      return false;
    case 'done':
      if (typeof data.ConversationId !== 'string') throw invalidResponse();
      handlers.onDone?.(data.ConversationId);
      return true;
    case 'error':
      handlers.onError?.();
      throw new ClientApiError(503, 'unavailable');
    default:
      throw invalidResponse();
  }
}

function parseSource(value: unknown): AiSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  const source = value as Record<string, unknown>;
  if (typeof source.Id !== 'string' || typeof source.Name !== 'string' || typeof source.Type !== 'string') {
    throw invalidResponse();
  }
  if (source.ProductionYear !== null && source.ProductionYear !== undefined && !Number.isSafeInteger(source.ProductionYear)) {
    throw invalidResponse();
  }
  return {
    id: source.Id,
    name: source.Name,
    type: source.Type,
    productionYear: typeof source.ProductionYear === 'number' ? source.ProductionYear : null,
  };
}

function invalidResponse(): ClientApiError {
  return new ClientApiError(200, 'invalid-response');
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
