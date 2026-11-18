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

In Coopanion, switch the rail to **advanced mode** (the button at the bottom of the left rail),
open **Model providers**, and pick the **Extension market** tab.

Market install, step by step:

1. **Model providers** (left rail, under "Access").
2. Tab **Extension market** next to **Settings**.
3. Type `coopanion` in the filter box — the entry is
   `coopanion-connect-workbuddy`, publisher `tao_kaka`.
4. Click **Install**. It should say *Extension installed* and **restart required**.
5. Click **Restart process** (or quit and reopen Coopanion). Extensions are only imported at
   process start, so nothing appears before this.
6. Back in **Model providers → Settings**: the module list now has **WorkBuddy**.
   Create an endpoint (+ New connection instance), pick it, and fill:

   | Field | Value |
   | --- | --- |
   | Base URL | `https://copilot.tencent.com` (already prefilled) |
   | Model | click **Fetch model list**, then pick one, e.g. `DeepSeek-V4.1-Flash` |
   | API key | **leave empty** — see [below](#why-there-is-no-api-key) |
   | Reasoning tier | `high` is a good default; `off` for cheapest |
   | Context window | filled automatically from the catalog on save (e.g. `1000000`) |
   | Max output tokens | filled automatically to the model maximum (e.g. `128000`) |

   Both numbers come from the catalog the extension already fetched, so there is nothing to type.
   If you do edit them, your value wins; the only rule is that the context window has to stay
   larger than the max output, otherwise the extension drops the context window instead of
   letting the save fail.

7. **Test connection**, then **Activate**.
8. The start page now lists it under *Connected models* as `WorkBuddy · <model>`.

The market catalog is generated from npm by keyword (`cortico-provider`), so no PR or review
is involved: publishing a new version to npm is what makes it show up.

Alternative without npm — install from this folder: the same **Extension market** tab has
**Manual install → From a local path**, which takes a directory containing `package.json`.
Useful while hacking on the source, since it links instead of copying.

If the process was already running when you installed, a stale entry can stay listed until the
restart; the restart is not optional.

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

在 Coopanion 里先把左栏切到**高级模式**（左栏底部的按钮），打开**模型供应商**，进**扩展市场**页签。

从市场安装，一步步来：

1. 左栏「接入」下的**模型供应商**；
2. 「设置」旁边的**扩展市场**页签；
3. 筛选框里输 `coopanion`，条目是 `coopanion-connect-workbuddy`，发布者 `tao_kaka`；
4. 点**安装**，提示「安装成功」并**需要重启**；
5. 点**重启进程**（或者退出重开 Coopanion）。扩展只在进程启动时加载，重启前什么都不会出现；
6. 回到**模型供应商 → 设置**，模块列表里多出 **WorkBuddy**。新建一条供应商实例，选它，填：

   | 字段 | 值 |
   | --- | --- |
   | Base URL | `https://copilot.tencent.com`（已预填） |
   | 模型 | 点**获取模型列表**后选，如 `DeepSeek-V4.1-Flash` |
   | API Key | **留空** —— 原因见[下文](#为什么不需要-api-key) |
   | 推理强度 | 默认 `high`；想省钱选 `off` |
   | 上下文上限 | 保存时按模型目录自动填（如 `1000000`） |
   | 最大输出 token | 保存时自动填成该模型的最大值（如 `128000`） |

   这两个数字来自扩展已经拉过的模型目录，不用手填。手工改过就以你填的为准；
   唯一的约束是上下文上限必须大于最大输出，否则扩展宁可把上下文上限清空，也不让保存失败。

7. **测试连接**，通过后**激活**；
8. 开始页的「已连接的模型：」就会出现 `WorkBuddy · <模型名>`。

市场目录是按关键字（`cortico-provider`）扫 npm 生成的，没有 PR、也没有人工审核——
往 npm 发新版本就是上架。

不想走 npm 的话，同一个**扩展市场**页签里有**手动安装 → 从本机目录安装**，
选包含 `package.json` 的目录即可；改源码时用它更方便，因为它是链接而不是拷贝。

装的时候进程已经在跑的话，列表里可能留一个旧条目，等重启才更新——重启这步省不掉。

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
