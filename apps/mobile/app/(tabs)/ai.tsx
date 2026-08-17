import {
  Alert,
  Chip,
  Select,
  Surface,
  Spinner,
  TextArea,
  TextField,
  Typography,
} from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { TvButton as Button } from '../../src/ui/TvButton';
import { TvPressable } from '../../src/ui/TvPressable';
import {
  getAiConversation,
  getAiModels,
  listAiConversations,
  deleteAiConversation,
  streamAiChat,
  randomUuid,
  isAbortError,
  ClientApiError,
  type AiConversationSummary,
  type AiMessage,
  type AiModel,
  type AiSource,
} from '@tjxy/client-api';
import { useClient } from '../../src/session';
import { Page, PageHeader } from '../../src/ui/Page';

const suggestions = [
  '根据我的观影偏好，推荐一部适合今晚看的电影。',
  '从我的媒体库里找一部容易错过的佳作。',
  '结合我的观看记录，我接下来应该继续看什么？',
];

export default function AiScreen() {
  const client = useClient();
  const router = useRouter();
  const [models, setModels] = useState<AiModel[]>([]);
  const [conversations, setConversations] = useState<AiConversationSummary[]>([]);
  const [modelId, setModelId] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolLabel, setToolLabel] = useState<string>();
  const abortRef = useRef<AbortController | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [accentForeground, muted, danger] = useThemeColor(['accent-foreground', 'muted', 'danger']);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([getAiModels(client), listAiConversations(client)])
      .then(([modelsResult, conversationsResult]) => {
        if (!active) return;
        if (modelsResult.status === 'fulfilled') {
          const nextModels = modelsResult.value;
          setModels(nextModels);
          setModelId(nextModels.find((model) => model.isDefault)?.id ?? nextModels[0]?.id ?? '');
        } else {
          setError(true);
          setErrorDetail('服务器暂时无法提供 AI 助手配置。');
        }
        if (conversationsResult.status === 'fulfilled') {
          setConversations(conversationsResult.value);
        } else if (modelsResult.status === 'fulfilled') {
          setError(true);
          setErrorDetail('对话历史暂时无法加载，你仍然可以开始新对话。');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [client]);

  async function openConversation(id: string) {
    if (streaming) return;
    try {
      const conversation = await getAiConversation(client, id);
      setConversationId(conversation.id);
      setModelId(conversation.modelId);
      setMessages(conversation.messages);
      setHistoryOpen(false);
      setError(false);
      setErrorDetail(undefined);
    } catch {
      setError(true);
      setErrorDetail('无法加载这次对话，请稍后再试。');
    }
  }

  function startNew() {
    abortRef.current?.abort();
    abortRef.current = null;
    removeEmptyAssistant();
    setConversationId(null);
    setMessages([]);
    setPrompt('');
    setToolLabel(undefined);
    setStreaming(false);
    setError(false);
    setErrorDetail(undefined);
    setHistoryOpen(false);
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    removeEmptyAssistant();
    setStreaming(false);
    setToolLabel(undefined);
    void listAiConversations(client).then(setConversations).catch(() => undefined);
  }

  function removeEmptyAssistant() {
    const assistantId = activeAssistantIdRef.current;
    if (!assistantId) return;
    setMessages((current) => current.filter((item) => (
      item.id !== assistantId || item.content.length > 0 || item.sources.length > 0
    )));
    activeAssistantIdRef.current = null;
  }

  async function removeConversation(id: string) {
    if (streaming) return;
    try {
      await deleteAiConversation(client, id);
      if (conversationId === id) startNew();
      setConversations(await listAiConversations(client));
    } catch {
      setError(true);
      setErrorDetail('无法删除这次对话。');
    }
  }

  async function send(text = prompt) {
    const message = text.trim();
    if (!message || !modelId || streaming) return;
    const userMessage: AiMessage = {
      id: randomUuid(),
      role: 'user',
      content: message,
      sources: [],
      createdAt: new Date().toISOString(),
    };
    const assistantId = randomUuid();
    activeAssistantIdRef.current = assistantId;
    const newConversationId = conversationId ? null : randomUuid();
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: 'assistant', content: '', sources: [], createdAt: new Date().toISOString() },
    ]);
    setPrompt('');
    setStreaming(true);
    setToolLabel(undefined);
    setError(false);
    setErrorDetail(undefined);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await streamAiChat(client, {
        conversationId,
        newConversationId,
        modelId,
        message,
      }, {
        onConversation: (id) => { setConversationId(id); },
        onDone: (id) => { setConversationId(id); },
        onTool: setToolLabel,
        onDelta: (delta) => {
          setMessages((current) => current.map((item) => (
            item.id === assistantId ? { ...item, content: item.content + delta } : item
          )));
        },
        onSources: (items) => {
          setMessages((current) => current.map((item) => (
            item.id === assistantId ? { ...item, sources: items } : item
          )));
        },
      }, abort.signal);
      try {
        setConversations(await listAiConversations(client));
      } catch {
        setError(true);
        setErrorDetail('回复已经完成，但对话历史暂时无法刷新。');
      }
    } catch (failure) {
      if (!abort.signal.aborted && !isAbortError(failure)) {
        if (__DEV__) {
          console.warn(
            'AI chat failed',
            failure instanceof ClientApiError
              ? { kind: failure.kind, status: failure.status, message: failure.message }
              : failure,
          );
        }
        setError(true);
        setErrorDetail(chatErrorDetail(failure));
        setMessages((current) => current.filter((item) => (
          item.id !== assistantId || item.content.length > 0 || item.sources.length > 0
        )));
      }
    } finally {
      if (abortRef.current === abort) {
        abortRef.current = null;
        activeAssistantIdRef.current = null;
        setStreaming(false);
        setToolLabel(undefined);
      }
    }
  }

  if (loading) {
    return (
      <Page>
        <View className="items-center py-20"><Spinner /></View>
      </Page>
    );
  }

  if (models.length === 0) {
    return (
      <Page>
        <PageHeader eyebrow="AI 助手" title="AI 助手" />
        <Alert status={error ? 'danger' : 'warning'}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{error ? '无法加载 AI 助手' : 'AI 助手尚未配置'}</Alert.Title>
            <Alert.Description>
              {errorDetail ?? (error ? '服务器暂时无法提供 AI 助手配置。' : '请联系管理员启用至少一个模型。')}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </Page>
    );
  }

  const activeConversationTitle = conversations.find((item) => item.id === conversationId)?.title;
  const selectedModel = models.find((model) => model.id === modelId);

  return (
    <Page padded={false} scroll={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <View className="flex-1 pb-3">
        <View className="min-h-16 flex-row items-center gap-2 border-b border-border px-4 py-2">
          <Button
            accessibilityLabel={historyOpen ? '关闭对话历史' : '打开对话历史'}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => { setHistoryOpen((current) => !current); }}
          >
            <Ionicons color={muted} name={historyOpen ? 'close' : 'albums-outline'} size={18} />
          </Button>
          <View className="min-w-0 flex-1">
            <Typography className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {activeConversationTitle ?? 'AI 助手'}
            </Typography>
            <Typography className="text-xs text-muted" numberOfLines={1}>
              {activeConversationTitle ? '基于你的媒体库进行对话' : '影视内容与个性化观影建议'}
            </Typography>
          </View>
          <View className="flex-row items-center gap-0.5">
            {conversationId ? (
              <Button
                accessibilityLabel="删除对话"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => { void removeConversation(conversationId); }}
              >
                <Ionicons color={danger} name="trash-outline" size={18} />
              </Button>
            ) : null}
            <Button accessibilityLabel="新建对话" isIconOnly size="sm" variant="ghost" onPress={startNew}>
              <Ionicons color={muted} name="create-outline" size={19} />
            </Button>
          </View>
        </View>
        {historyOpen ? (
          <Surface
            className="max-h-44 rounded-md border border-border p-2"
            style={{ borderRadius: 10, left: 16, position: 'absolute', right: 16, top: 76, zIndex: 10 }}
            variant="secondary"
          >
            {conversations.length > 0 ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                <View className="gap-1">
                  {conversations.slice(0, 12).map((item) => (
                    <TvPressable
                      className={`rounded-md px-3 py-2.5 ${item.id === conversationId ? 'bg-accent' : ''}`}
                      key={item.id}
                      style={{ borderRadius: 8 }}
                      onPress={() => { void openConversation(item.id); }}
                    >
                      <Typography
                        className={`text-sm ${item.id === conversationId ? 'text-accent-foreground' : 'text-foreground'}`}
                        numberOfLines={1}
                      >
                        {item.title}
                      </Typography>
                    </TvPressable>
                  ))}
                </View>
              </ScrollView>
            ) : (
              <Typography className="px-3 py-2 text-sm text-muted">还没有历史对话</Typography>
            )}
          </Surface>
        ) : null}
        {error ? (
          <Alert className="mx-4 mt-3" status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>这次对话没有完成</Alert.Title>
              <Alert.Description>{errorDetail ?? '请稍后再试，或开始新的对话。'}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingVertical: 20 }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => { scrollRef.current?.scrollToEnd({ animated: true }); }}
        >
          <View className="flex-1 gap-3" style={{ alignSelf: 'center', maxWidth: 714, width: '100%' }}>
          {messages.length === 0 ? (
            <View className="flex-1 justify-center py-8">
              <View className="mb-7">
                <View className="mb-4 size-11 items-center justify-center rounded-lg bg-accent" style={{ borderRadius: 10 }}>
                  <Ionicons color={accentForeground} name="sparkles" size={20} />
                </View>
                <Typography.Heading className="text-2xl font-semibold text-foreground">想看点什么？</Typography.Heading>
                <Typography.Paragraph className="mt-2 text-sm leading-6 text-muted">
                  从你的媒体库与观看记录出发，找一部真正适合现在的影片。
                </Typography.Paragraph>
              </View>
              <View className="gap-2">
                {suggestions.map((item) => (
                  <Button
                    className="h-auto min-h-11 justify-start rounded-lg py-3"
                    key={item}
                    style={{ borderRadius: 10 }}
                    variant="outline"
                    onPress={() => { setPrompt(item); }}
                  >
                    <Button.Label className="text-left">{item}</Button.Label>
                  </Button>
                ))}
              </View>
            </View>
          ) : messages.map((message) => (
            message.role === 'user' ? (
              <Surface
                className="max-w-[92%] self-end rounded-lg bg-accent p-3.5"
                key={message.id}
                style={{ borderRadius: 10 }}
                variant="transparent"
              >
                <Typography className="text-accent-foreground">{message.content}</Typography>
              </Surface>
            ) : (
              <View className="self-start" key={message.id}>
                <Typography className="leading-6 text-foreground">
                  {message.content || (streaming ? '正在思考…' : '')}
                </Typography>
                {message.sources.length > 0 ? (
                  <View className="mt-3 flex-row flex-wrap gap-2">
                    {message.sources.map((source) => (
                      <SourceChip key={source.id} source={source} onOpen={() => { router.push(`/items/${source.id}`); }} />
                    ))}
                  </View>
                ) : null}
              </View>
            )
          ))}
          {toolLabel ? <Typography className="text-sm text-muted">{toolLabel}</Typography> : null}
          </View>
        </ScrollView>
        <Surface
          className="mx-2 rounded-xl border border-border p-2"
          style={{ alignSelf: 'center', borderRadius: 12, maxWidth: 714, width: '100%' }}
          variant="default"
        >
          <TextField className="w-full" isDisabled={streaming}>
            <TextArea
              className="h-16 max-h-24 min-h-0 border-0 bg-transparent px-2 py-2"
              maxLength={16_000}
              placeholder="询问影视信息或个性化推荐"
              style={{ borderRadius: 8 }}
              value={prompt}
              variant="secondary"
              onChangeText={setPrompt}
            />
          </TextField>
          <View className="mt-1 flex-row items-center justify-between gap-2">
            <Select
              isDisabled={conversationId !== null || streaming}
              value={selectedModel ? { label: selectedModel.displayName, value: selectedModel.id } : undefined}
              onValueChange={(option) => { if (option) setModelId(option.value); }}
            >
              <Select.Trigger
                accessibilityLabel="选择 AI 模型"
                className="h-9 min-h-9 w-44 flex-row rounded-lg px-2"
                style={{ borderRadius: 8 }}
              >
                <Ionicons color={muted} name="globe-outline" size={16} />
                <Select.Value className="min-w-0 flex-1 text-xs" placeholder="选择模型" />
                <Select.TriggerIndicator />
              </Select.Trigger>
              <Select.Portal>
                <Select.Overlay />
                <Select.Content
                  align="start"
                  className="rounded-xl p-1"
                  placement="top"
                  presentation="popover"
                  style={{ borderRadius: 12 }}
                  width={220}
                >
                  <Select.ListLabel className="px-2 pb-1 text-xs">选择模型</Select.ListLabel>
                  {models.map((model) => (
                    <Select.Item
                      className="rounded-lg"
                      key={model.id}
                      label={model.displayName}
                      style={{ borderRadius: 8 }}
                      value={model.id}
                    >
                      <Select.ItemLabel />
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Portal>
            </Select>
            <Button
              accessibilityLabel={streaming ? '停止回复' : '发送消息'}
              isIconOnly
              isDisabled={streaming ? false : !prompt.trim()}
              style={{ borderRadius: 12 }}
              variant={streaming ? 'secondary' : 'primary'}
              onPress={() => { streaming ? stop() : void send(); }}
            >
              <Ionicons
                color={streaming ? muted : accentForeground}
                name={streaming ? 'stop' : 'arrow-up'}
                size={18}
              />
            </Button>
          </View>
        </Surface>
        <Typography className="pt-1 text-center text-xs text-muted">
          AI 可能会出错，请核实重要信息。
        </Typography>
        </View>
      </KeyboardAvoidingView>
    </Page>
  );
}

function SourceChip({ source, onOpen }: { source: AiSource; onOpen: () => void }) {
  return (
    <TvPressable focusBorderRadius={999} onPress={onOpen}>
      <Chip size="sm" variant="soft">
        <Chip.Label>{source.name}</Chip.Label>
      </Chip>
    </TvPressable>
  );
}

function chatErrorDetail(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.kind === 'network') return '无法连接到服务器，请检查网络或服务器地址。';
    if (error.kind === 'authentication') return '登录已失效，请重新登录后再试。';
    if (error.kind === 'authorization') return '当前账户没有使用 AI 助手的权限。';
    if (error.kind === 'validation') return '这次请求未被服务器接受。';
    if (error.kind === 'rate-limit') return '今日 AI 用量已达上限，请明天再试。';
    if (error.kind === 'unavailable') return 'AI 助手暂时不可用，请稍后再试。';
    if (error.kind === 'invalid-response') return '服务器返回的内容无法解析。';
  }
  return '请稍后再试，或开始新的对话。';
}
