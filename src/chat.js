/**
 * WorkBuddy Chat Completions 客户端。
 *
 * 上游是标准 OpenAI Chat Completions（`POST /v2/chat/completions`），但**只接受流式**：
 * 非流式会被 400 `Non-stream chat request is currently not supported` 拒绝。
 * 框架的主循环总是带 `onEvent`（生成请求一律流式），`OpenAIHttpClient.applyStreamFlags`
 * 默认发的 `stream: true` + `stream_options.include_usage` 上游也接受。
 *
 * 与 `cortico-provider-coo` 的 `VendorChat` 的差别只有三处：
 * 1. 端点路径换成 `/v2/chat/completions`；
 * 2. 请求头换成 WorkBuddy 桌面端身份（`X-IDE-*` / `X-Product*` / `User-Agent`）；
 * 3. 令牌在每次请求时现取（凭据文件会被桌面端刷新，401 时重取一次）。
 */
import { nullLogger } from 'cortico/core/util.ts';
import { RESERVED_FRAME_NAMES } from 'cortico/core/loop.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import {
  dropPastThinking,
  mapTools,
  renderMessagesWithMedia,
} from 'cortico/providers/transport/history.ts';
import { SYNTHETIC_REASONING_TEXT } from 'cortico/providers/transport/responses-input.ts';
import { CHAT_PATH, commonHeaders } from './upstream.js';

/** Text of a tool result that held images only, once they move to the next user message. */
const IMAGE_RESULT = '[image]';

const CHAT_RESULTS = {
  isResult: (m) => m.role === 'tool',
  field: 'content',
  text: 'text',
  image: 'image_url',
  user: { role: 'user' },
};

/** 工具结果里的图片挪到紧随其后的一条 user 消息（Chat 只在 user 消息里收图）。 */
export function imagesAfterResults(messages, format = CHAT_RESULTS) {
  const out = [];
  let images = [];
  const flush = () => {
    if (images.length) out.push({ ...format.user, content: images });
    images = [];
  };
  for (const m of messages) {
    const result = format.isResult(m);
    if (!result) flush();
    const parts = result && Array.isArray(m[format.field]) ? m[format.field] : null;
    if (!parts?.some((p) => p.type === format.image)) {
      out.push(m);
      continue;
    }
    const text = parts.filter((p) => p.type === format.text).map((p) => String(p.text ?? '')).join('\n');
    out.push({ ...m, [format.field]: text || IMAGE_RESULT });
    images.push(...parts.filter((p) => p.type === format.image));
  }
  flush();
  return out;
}

const MEDIA = /^(image|audio|video)\//;

/**
 * 最新一批投递（user 消息或外部事件帧调用）之前的附件全部剥掉：
 * 留着它们会让每一次请求都重发旧图。
 */
export function sinceLastDelivery(context) {
  let delivery = context.length - 1;
  for (; delivery >= 0; delivery--) {
    const { item } = context[delivery];
    if ((item.type === 'message' && item.role === 'user')
      || (item.type === 'function_call' && RESERVED_FRAME_NAMES.has(item.name))) break;
  }
  let output = context.length - 1;
  for (; output >= 0; output--) {
    const { item } = context[output];
    if (item.type === 'reasoning'
      || (item.type === 'message' && item.role === 'assistant')
      || (item.type === 'function_call' && !RESERVED_FRAME_NAMES.has(item.name))) break;
  }
  const from = Math.min(delivery, output + 1);
  return context.map((entry, index) => {
    const blobs = entry.context.blobs;
    if (index >= from || !blobs?.some((b) => MEDIA.test(b.mime))) return entry;
    return { ...entry, context: { ...entry.context, blobs: blobs.filter((b) => !MEDIA.test(b.mime)) } };
  });
}

/** 关闭思考时发 `none`；WorkBuddy 的所有模型都接受该值。 */
function reasoningEffort(spec) {
  const level = spec.thinking ? spec.reasoningEffort : 'none';
  return level ? { reasoning_effort: level } : {};
}

/** 本轮推理：最新 user 消息之前的 reasoning 在 keepThinking 关闭时丢掉；开着时补齐空推理。 */
function roundReasoning(messages, opts) {
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== 'user') start--;
  const cut = Math.max(start, 0);
  const before = messages.slice(0, cut);
  const round = messages.slice(cut);
  return [
    ...(opts.keepThinking ? before : dropPastThinking(before)),
    ...(opts.synthetic
      ? round.map((m) => (m.role === 'assistant' && m.tool_calls?.length && !m.reasoning_content
        ? { ...m, reasoning_content: SYNTHETIC_REASONING_TEXT }
        : m))
      : round),
  ];
}

export class WorkBuddyChat extends OpenAIHttpClient {
  constructor(opts) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.opts = opts;
    this.chatPath = CHAT_PATH;
  }

  buildResponseBody(request, options) {
    return super.buildResponseBody(request, options.context
      ? { ...options, context: sinceLastDelivery(options.context) }
      : options);
  }

  /** 每次请求现取令牌，避免长会话里凭据过期。 */
  async headers() {
    const accessToken = await this.opts.token();
    return commonHeaders(accessToken, { Accept: 'application/json, text/event-stream' });
  }

  /** 401/403：丢掉缓存重取一次；取到新令牌才能重试。 */
  async onAuthError() {
    const fresh = await this.opts.refresh();
    return fresh !== null && fresh !== undefined;
  }

  buildBody(spec, messages, tools) {
    const history = roundReasoning(messages, {
      keepThinking: this.opts.keepThinking?.() !== false,
      synthetic: !!spec.thinking && this.opts.syntheticReasoning === true,
    });
    const body = {
      model: spec.model,
      messages: imagesAfterResults(renderMessagesWithMedia(history, this.opts.media, { keepReasoning: spec.thinking })),
      ...reasoningEffort(spec),
    };
    if (spec.temperature !== undefined) body.temperature = spec.temperature;
    if (spec.maxTokens !== undefined) body.max_tokens = spec.maxTokens;
    const mapped = mapTools(tools);
    if (mapped) body.tools = mapped;
    return body;
  }
}
