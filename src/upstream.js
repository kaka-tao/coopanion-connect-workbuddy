/**
 * WorkBuddy 上游（腾讯 copilot.tencent.com）的常量、请求头与模型目录。
 *
 * 与 `POST /v2/chat/completions` 一致的 OpenAI Chat Completions 协议，但只接受流式；
 * 模型表来自 `GET /v3/config` 的 `data.models`（富元数据），再与 `data.agents[0].models`
 * （当前账号可用的模型 id）取交集。
 */

export const BASE_URL = 'https://copilot.tencent.com';
export const CONFIG_PATH = '/v3/config';
export const MODELS_PATH = '/v2/enterprises/personal/models';
export const CHAT_PATH = '/v2/chat/completions';
export const PRODUCT_VERSION = '2.63.2';
export const APP_CHANNEL_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0';

/** 桌面端身份；上游据此把调用记成官方 CLI。 */
export function commonHeaders(accessToken, extra = {}) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': APP_CHANNEL_UA,
    'X-Requested-With': 'XMLHttpRequest',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'CLI',
    'X-Product': 'WorkBuddy',
    'X-Product-Version': PRODUCT_VERSION,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...extra,
  };
}

async function getJson(url, headers, timeoutMs = 20_000) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`WorkBuddy ${url} 返回 ${response.status}`);
  return response.json();
}

/** 一条模型元数据 → 框架的 ListedModel。 */
function toListedModel(model) {
  const contextWindow = Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0 ? model.maxInputTokens : undefined;
  const maxOutputTokens = Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0 ? model.maxOutputTokens : undefined;
  return {
    id: model.id,
    displayName: typeof model.name === 'string' && model.name !== '' ? model.name : undefined,
    contextWindow,
    maxOutputTokens,
    inputImages: model.supportsImages === true,
  };
}

/**
 * 拉模型目录。优先 `/v3/config`（含元数据与促销），失败再退到
 * `/v2/enterprises/personal/models`（同一份表，无 agent 白名单）。
 * @returns {Promise<{ models: Array<object>, source: string }>}
 */
export async function fetchCatalog(accessToken, log) {
  const headers = commonHeaders(accessToken);
  let agentModels = null;
  let metadata = [];
  let source = 'config';
  try {
    const config = await getJson(`${BASE_URL}${CONFIG_PATH}`, headers);
    const data = config?.data ?? {};
    const agent = Array.isArray(data.agents) ? data.agents[0] : null;
    if (Array.isArray(agent?.models)) agentModels = agent.models.filter((id) => typeof id === 'string');
    if (Array.isArray(data.models)) metadata = data.models.filter((m) => m && typeof m.id === 'string');
  } catch (error) {
    log?.warn(`WorkBuddy /v3/config 不可用，改读模型列表接口: ${error instanceof Error ? error.message : String(error)}`);
    source = 'models';
  }

  if (metadata.length === 0) {
    try {
      const listing = await getJson(`${BASE_URL}${MODELS_PATH}`, headers);
      const data = listing?.data?.models ?? listing?.data ?? listing?.models;
      if (Array.isArray(data)) metadata = data.filter((m) => m && typeof m.id === 'string');
    } catch (error) {
      log?.warn(`WorkBuddy 模型列表接口不可用: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const allowed = agentModels ? new Set(agentModels) : null;
  const models = metadata
    .filter((m) => allowed === null || allowed.has(m.id))
    .map(toListedModel)
    .filter((m) => m.id !== '');
  return { models, source };
}

/** WorkBuddy 的 SSE 一定以 `data:` 行给出；错误也可能塞进 200 的正文里。 */
export function upstreamError(text) {
  try {
    const parsed = JSON.parse(text);
    const code = parsed?.code;
    if (typeof code === 'number' && code !== 0 && code !== 200) {
      return `WorkBuddy ${code}: ${parsed?.msg ?? parsed?.message ?? '上游拒绝'}`;
    }
  } catch {
    // 不是 JSON，忽略
  }
  return null;
}
