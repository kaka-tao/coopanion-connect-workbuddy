# coopanion-connect-workbuddy

A **[Coopanion](https://github.com/Pal-AI-Lab/Coopanion)** provider extension that plugs
**Tencent WorkBuddy / CodeBuddy** in as a model endpoint.

What you get after installing:

- A provider module named **WorkBuddy** shows up in the model settings, and
  "fetch model list" fills a picker with the 16 models your account can use;
- Once a model is selected and activated, the start page lists it under
  "connected models" as `WorkBuddy · <model>`;
- **No API key to paste** — the sign-in already stored by the desktop app is reused.

中文说明见下方 [中文](#中文说明)。

## Why there is no API key

The WorkBuddy desktop app keeps its session in a `.info` file:

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

`auth.accessToken` there is an encrypted field (`{"$wbEncrypted":1,"envelope":"…"}`, AES-256-GCM).
The unsealing key is not in the file — it is a build-time constant inside the desktop binary,
so the only way to get it is to ask the app:

```
ELECTRON_RUN_AS_NODE=1 "C:\Program Files\WorkBuddy\WorkBuddy.exe" \
  -e "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())"
```

This extension runs exactly that (`fetchAtRestKeyPayload` in `src/credentials.js`), derives the
field key from the returned `atRestSecretKey`, and decrypts the token. Therefore:

- the desktop app must be installed on this machine (`WORKBUDDY_APP_EXECUTABLE` overrides the path);
- `WORKBUDDY_AT_REST_KEY` may be set to inject the key payload directly instead;
- tokens never touch disk or logs; they are cached in memory for 5 minutes and dropped on 401.

If several accounts have signed in on this machine, the auth directory holds several `.info`
files and only the newest one works. This extension sorts them by modification time (newest
first), tries them one by one, and moves to the next one when a token is rejected.

## Upstream

| Purpose | Request |
| --- | --- |
| Model catalog | `GET https://copilot.tencent.com/v3/config` (`data.models` ∩ `data.agents[0].models`) |
| Chat | `POST https://copilot.tencent.com/v2/chat/completions` |
| Catalog fallback | `GET https://copilot.tencent.com/v2/enterprises/personal/models` |

The upstream is plain OpenAI Chat Completions but **streaming is mandatory** — a non-streaming
request answers `400 Non-stream chat request is currently not supported`. Coopanion always sends
generation requests with `onEvent`, so that requirement is met by construction. Requests carry
WorkBuddy desktop identity headers (`X-IDE-Name`, `X-Product*`, UA).

`tools` are forwarded, so tool calls work end to end.

## Install

Two ways:

1. In Coopanion, go to the provider settings → extensions → install from a local directory, and
   pick this folder. Or
2. Install it from npm (see [Publishing](#publishing)): it appears in the provider extension
   market once published, because the market catalog is generated from npm by keyword.

Either way, restart Coopanion afterwards so the module is imported.

Then create an endpoint in the model settings:

| Field | Value |
| --- | --- |
| Module | WorkBuddy |
| Base URL | `https://copilot.tencent.com` |
| Model | click "fetch model list" and pick one, e.g. `deepseek-v4.1-flash` |
| Secret | leave empty |

Then activate it.

## Reasoning tiers

`off` / `low` / `high` / `max`, mapped onto the upstream `reasoning_effort`
(`none` is sent when thinking is off). The upstream does not validate the value, it is passed through.

## Files

| File | Purpose |
| --- | --- |
| `src/index.js` | The `ProviderModule` declaration and `create()` |
| `src/credentials.js` | Credential discovery, unsealing, token refresh |
| `src/upstream.js` | Upstream constants, headers, model catalog |
| `src/chat.js` | `WorkBuddyChat`, extending the framework's `OpenAIHttpClient` |
| `describe.json`, `icon.svg` | Shown in the market and in the settings panel |

## Market tags

- `unofficial-api` — this drives an internal endpoint of a coding-agent app with the user's own
  account, which the vendor does not offer to third parties.
- `external-setup` — the package alone is not enough; the WorkBuddy desktop app has to be
  installed and signed in on this machine.

## Publishing

```bash
npm publish            # catalog is generated from npm, no PR needed
```

The market scanner looks for `keywords: "cortico-provider"` on npm, so keep that keyword.

## Licence

MIT. The credential-unsealing logic is ported from `cortico-world-workbuddy`, which implements
the same upstream.

---

## 中文说明

Coopanion（Cortico）的 **provider 扩展**：把腾讯 WorkBuddy / CodeBuddy 当作一个 LLM 供应端点用。

装上之后：

- 模型设置里会出现一个叫 **WorkBuddy** 的供应模块，点「获取模型列表」就能挑模型；
- 选定模型并激活后，开始页的「已连接的模型」会显示 `WorkBuddy · <模型>`；
- 不需要填 API Key —— 登录状态直接复用桌面端。

### 为什么不需要 API Key

WorkBuddy 桌面端把登录态写在自己目录里的 `.info` 文件：

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

其中 `auth.accessToken` 是加密字段（`{"$wbEncrypted":1,"envelope":"…"}`，AES-256-GCM）。
解封密钥不在文件里，而是桌面端二进制内的构建期常量，只能让它自己吐出来：

```
ELECTRON_RUN_AS_NODE=1 "C:\Program Files\WorkBuddy\WorkBuddy.exe" \
  -e "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())"
```

本扩展在需要时执行这段脚本（`src/credentials.js` 的 `fetchAtRestKeyPayload`），
用返回的 `atRestSecretKey` 派生字段密钥并解出令牌。所以：

- 桌面端必须装在这台机器上（找不到时可设 `WORKBUDDY_APP_EXECUTABLE` 指路径）；
- 也接受 `WORKBUDDY_AT_REST_KEY` 环境变量直接注入密钥负载；
- 令牌不写盘、不进日志，内存里缓存 5 分钟；401 时丢掉缓存重取。

登录过多个账号时目录里会并存多份 `.info`，只有最后登录那份能用，
所以按文件修改时间从新到旧逐个试，401 就换下一份。

### 上游

| 用途 | 请求 |
| --- | --- |
| 模型目录 | `GET https://copilot.tencent.com/v3/config`（取 `data.models` ∩ `data.agents[0].models`） |
| 对话 | `POST https://copilot.tencent.com/v2/chat/completions` |
| 模型目录兜底 | `GET https://copilot.tencent.com/v2/enterprises/personal/models` |

上游是标准 OpenAI Chat Completions，但**只接受流式**（非流式返回 400
`Non-stream chat request is currently not supported`）。Coopanion 的生成请求一律带
`onEvent`，所以天然满足。请求头带 WorkBuddy 桌面端身份（`X-IDE-Name` / `X-Product*` / UA），
上游据此把调用记成官方客户端。

`tools` 会原样转发，工具调用可以完整往返。

### 安装

两种方式：

1. 在 Coopanion 的模型设置 →「扩展」里选「从本地目录安装」，挑中本目录；
2. 从 npm 安装（见「发布」）。上架后它会出现在「模型供应商 → 扩展市场」里，
   因为市场目录是用关键字扫 npm 生成的。

装好后重启 Coopanion，再在「模型」页新建端点：

| 字段 | 值 |
| --- | --- |
| 模块 | WorkBuddy |
| Base URL | `https://copilot.tencent.com` |
| 模型 | 点「获取模型列表」后选，或手填如 `deepseek-v4.1-flash` |
| 密钥 | 留空 |

然后「激活」。

### 强度档位

`off` / `low` / `high` / `max` 四档，映射到上游的 `reasoning_effort`
（关闭思考时发 `none`）。上游对各档都不校验，直接透传。

### 文件

| 文件 | 作用 |
| --- | --- |
| `src/index.js` | ProviderModule 声明与 `create()` |
| `src/credentials.js` | 桌面端凭据发现、解封、令牌刷新 |
| `src/upstream.js` | 上游常量、请求头、模型目录 |
| `src/chat.js` | `WorkBuddyChat`（继承框架的 `OpenAIHttpClient`） |
| `describe.json` / `icon.svg` | 扩展在市场与面板里展示用 |

### 市场标签

- `unofficial-api` —— 用用户自己的账号调用编码助手 App 的内部端点，厂商没有向第三方开放；
- `external-setup` —— 光装这个包还不够，本机得先装并且登录 WorkBuddy 桌面端。

### 发布

```bash
npm publish            # 目录由 npm 自动生成，不用提 PR
```

市场扫描器按 `keywords: "cortico-provider"` 找包，这个关键字必须保留。

### 许可

MIT。凭据解封逻辑移植自 `cortico-world-workbuddy`（同一上游实现）。
