# Changelog

## 0.1.1

首个公开版本。

- 把腾讯 WorkBuddy（CodeBuddy）接成 Coopanion 的模型供应商（`kind: provider`, `api: 6`）。
- 复用桌面端已登录的凭据，端点不需要填 API Key：从
  `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` 读加密的 `auth.accessToken`，
  用桌面端二进制吐出的 at-rest 密钥解封（AES-256-GCM，AAD 按 `WB-AAD` / `sym-v1` / `WBEV1` / framing 2 转录）。
- 多账号并存时按文件修改时间从新到旧逐个试，401 自动换下一份并刷新。
- 模型目录走 `GET /v3/config`（取 `data.models` ∩ `data.agents[0].models`），旧接口 `/v2/enterprises/personal/models` 兜底；
  16 个模型带上下文窗口、最大输出与图片能力。
- 对话走 `POST /v2/chat/completions`，即标准 OpenAI Chat Completions 的强制流式版本；转发 `tools`，工具调用可用。
- 四档强度：`off` / `low` / `high` / `max`，映射到上游 `reasoning_effort`（关闭思考时发 `none`）。
- 支持文本与图片输入。

### 已实测

- Windows 11 + Coopanion 0.2.21：扩展加载、模块注册、模型列表、测试连接、激活、跨重启持久化、真实对话往返。
- 工具往返（`function_call` → 结果回填 → 自然语言回答）通过。
- 非流式请求上游返回 400，因此本扩展始终流式请求。
