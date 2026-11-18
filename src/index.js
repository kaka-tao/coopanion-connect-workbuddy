/**
 * WorkBuddy（腾讯 CodeBuddy / copilot.tencent.com）LLM 供应模块。
 *
 * 与常规 provider 的差别：没有可填的 API Key。凭据从 WorkBuddy 桌面端自己的登录状态里读，
 * 加密字段用桌面端二进制吐出的 at-rest 密钥解封（见 `credentials.js`）。因此本模块
 * 始终让 `entry.secret` 为空，框架就不会把它判成「缺密钥」。
 */
import { nullLogger } from 'cortico/core/util.ts';
import { discoverAllCredentials, resolveTokensWithKey } from './credentials.js';
import { WorkBuddyChat } from './chat.js';
import { BASE_URL, KNOWN_LIMITS, fetchCatalog } from './upstream.js';

const TIERS = (t) => [
  { id: 'off', label: t.tiers.off, thinking: false },
  { id: 'low', label: t.tiers.low, thinking: true, effort: 'low' },
  { id: 'high', label: t.tiers.high, thinking: true, effort: 'high' },
  { id: 'max', label: t.tiers.max, thinking: true, effort: 'max' },
];

const TEXT = {
  zh: {
    title: 'WorkBuddy',
    description: '使用 WorkBuddy 桌面端的登录状态，无需 API Key。',
    temperatureNote: 'WorkBuddy 的部分模型固定温度，调温度对它们无效。',
    tiers: { off: '不思考', low: '低强度', high: '高强度', max: '最大强度' },
    noCredential: '没有找到 WorkBuddy 登录状态：请打开 WorkBuddy 桌面端登录一次。',
    unseal: '找到了 WorkBuddy 凭据，但读不到解封密钥：请确认 WorkBuddy 桌面端已安装（需要它提供密钥）。',
    expired: 'WorkBuddy 登录状态已过期：请在桌面端重新登录。',
  },
  en: {
    title: 'WorkBuddy',
    description: 'Reuse the WorkBuddy desktop sign-in; no API key required.',
    temperatureNote: 'Some WorkBuddy models run at a fixed temperature, so the setting has no effect.',
    tiers: { off: 'No thinking', low: 'Low', high: 'High', max: 'Max' },
    noCredential: 'No WorkBuddy sign-in found. Open the WorkBuddy desktop app and sign in once.',
    unseal: 'A WorkBuddy credential exists but its unsealing key is unavailable. The WorkBuddy desktop app must be installed.',
    expired: 'The WorkBuddy sign-in has expired. Sign in again in the desktop app.',
  },
};

const text = (language) => (language === 'en' ? TEXT.en : TEXT.zh);

// ---------------------------------------------------------------------------
// 凭据与令牌
//
// 目录里可能并存多份登录记录（登录过多个账号），只有最后登录那份能用，
// 所以按修改时间从新到旧逐个试；401 时换下一份，全部失败才算过期。
// ---------------------------------------------------------------------------

/** 本地扫描结果缓存：避免每次渲染面板都去读磁盘。 */
const PRESENCE_MS = 15_000;
let presence = null;

function presenceOf(language) {
  if (presence && Date.now() - presence.at < PRESENCE_MS) return presence;
  let found = [];
  try {
    found = discoverAllCredentials();
  } catch {
    found = [];
  }
  presence = { found, at: Date.now(), language };
  return presence;
}

const TOKEN_MS = 5 * 60_000;
/** `{ token, file, at }`；`file` 记住是哪份凭据解出来的。 */
let token = null;

async function tokenFrom(record) {
  const resolved = await resolveTokensWithKey(record.credential);
  if (resolved.accessToken) return resolved.accessToken;
  if (resolved.reason === 'unseal-key-missing') throw new Error(text('zh').unseal);
  throw new Error(text('zh').expired);
}

/** 取一个可用的 access token。失败抛出可读原因，交给框架显示。 */
async function accessToken() {
  if (token && Date.now() - token.at < TOKEN_MS) return token.token;
  const records = presenceOf('zh').found;
  if (records.length === 0) throw new Error(text('zh').noCredential);
  let lastError = null;
  for (const record of records) {
    try {
      const value = await tokenFrom(record);
      token = { token: value, file: record.file, at: Date.now() };
      return value;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(text('zh').expired);
}

/** 401/403 之后丢掉缓存、从下一份凭据开始重试；一份都取不到时返回 null。 */
async function refreshToken() {
  const previous = token?.file ?? null;
  token = null;
  presence = null;
  const records = presenceOf('zh').found;
  const ordered = previous === null
    ? records
    : [...records.filter((r) => r.file !== previous), ...records.filter((r) => r.file === previous)];
  for (const record of ordered) {
    try {
      const value = await tokenFrom(record);
      token = { token: value, file: record.file, at: Date.now() };
      return value;
    } catch {
      // 换下一份
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

const CATALOG_MS = 5 * 60_000;
let catalog = null;

async function models(log) {
  if (catalog && Date.now() - catalog.at < CATALOG_MS) return catalog.models;
  const { models: listed } = await fetchCatalog(await accessToken(), log);
  catalog = { models: listed, at: Date.now() };
  return listed;
}

/** 同步回答：上次拉到的目录里这个模型的输入窗口。 */
function contextWindowOf(model) {
  return catalog?.models.find((m) => m.id === model)?.contextWindow;
}

/** WorkBuddy 供应模块。 */
const WORKBUDDY = {
  id: 'workbuddy',
  title: 'WorkBuddy',
  description: 'Tencent WorkBuddy / CodeBuddy sign-in, no API key required.',
  describe: {
    protocols: ['openai-chat'],
    auth: ['web-session'],
    local: false,
    input: ['text', 'image'],
  },
  defaultBaseUrl: BASE_URL,
  baseUrlSuggestions: [BASE_URL],
  reasoningTiers: TIERS(TEXT.en),
  serviceTiers: [],
  temperatureNote: TEXT.en.temperatureNote,

  localize(language) {
    const t = text(language);
    return {
      title: t.title,
      description: t.description,
      reasoningTiers: TIERS(t),
      serviceTiers: [],
      temperatureNote: t.temperatureNote,
    };
  },

  /** 端点不留密钥：凭据由桌面端提供，写进 `.env` 只会让框架误判成缺密钥。 */
  normalize(entry) {
    const { secret: _secret, ...rest } = entry;
    const next = { ...rest, baseUrl: entry.baseUrl || BASE_URL };
    const spec = next.spec;
    const model = typeof spec?.model === 'string' ? spec.model.trim() : '';
    if (!model) return next;
    // 目录优先，未拉到目录时用内置表兜底；用户手填过就不覆盖。
    const known = catalog?.models.find((m) => m.id === model) ?? KNOWN_LIMITS[model];
    if (!known) return next;
    const filled = { ...spec, model };
    if (filled.contextWindow === undefined && known.contextWindow) filled.contextWindow = known.contextWindow;
    if (filled.maxTokens === undefined && known.maxOutputTokens) filled.maxTokens = known.maxOutputTokens;
    // 上游约束：上下文窗口必须大于最大输出。手填出矛盾时让出输出上限，别让保存失败。
    if (filled.contextWindow !== undefined && filled.maxTokens !== undefined && filled.contextWindow <= filled.maxTokens) {
      filled.contextWindow = undefined;
    }
    next.spec = filled;
    return next;
  },

  /** 本地状态：没有桌面端登录状态时，开始页与模型页都要说清楚原因。 */
  availability(name, entry, language) {
    const t = text(language);
    const { found } = presenceOf(language);
    if (found.length > 0) return { ready: true };
    return { ready: false, reason: t.noCredential };
  },

  create(name, entry, host) {
    const current = () => host.currentEntry?.() ?? entry;
    const media = { enabled: () => current().multimodal === true, read: host.readBlob };
    const baseUrl = (entry.baseUrl || BASE_URL).replace(/\/+$/, '');
    const log = host.log ?? nullLogger();
    const client = new WorkBuddyChat({
      baseUrl,
      token: accessToken,
      refresh: refreshToken,
      media,
      keepThinking: host.keepThinking,
      log,
      syntheticReasoning: true,
    });
    return {
      client,
      listModels: () => models(log),
      contextWindow: contextWindowOf,
      compatibilityKey: () => ['workbuddy', baseUrl],
    };
  },
};

export default WORKBUDDY;
