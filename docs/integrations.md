# 可选功能集成

`npm run init` 生成的初始配置只开启了基础聊天。如果你需要启用提醒、社交媒体解析、B 站推送或群股市等扩展功能，需要按需放开对应的权限开关并准备外部依赖。

## 1. 启用扩展功能的配置步骤

服务对业务工具采取多层权限校验，开启任一功能时通常需要检查以下配置文件（均位于 `$ONEBOT_CONFIG_ROOT` 下）：

1. **功能与会话白名单（`onebot-features.json`）**：控制哪个机器人账号、哪些群或管理员身份可以使用哪项业务（校验逻辑见 [`src/src/feature-policy.js`](../src/src/feature-policy.js)）。
2. **执行器开关（`onebot-executors.json`）**：控制具体的业务工具是否允许执行，以及超时时间和并发上限（见 [`src/src/features/settings.js`](../src/src/features/settings.js)）。
3. **Agent 工具白名单（`openclaw.json`）**：初始化时默认配置了 `"tools": { "deny": ["*"] }`。启用工具时，需要在全局和对应 Agent 的 `tools` 配置中显式放行所需的工具名称。
4. **后台与定时服务登记（`onebot-services.json`）**：如果某项功能包含周期性任务或外部主动推送，还需要在此登记服务身份、执行周期和允许投递的目标 QQ / 群（见 [`src/src/access/services.js`](../src/src/access/services.js)）。

## 2. 内置扩展模块说明

| 模块 | 仓库内已包含的部分 | 部署时需自行准备的环境与配置 |
|---|---|---|
| **B 站动态与直播推送**<br>[`src/src/features/bilibili.js`](../src/src/features/bilibili.js)<br>[`integrations/bilibili-notify/`](../integrations/bilibili-notify/) | 订阅同步、带鉴权的 Webhook 接收端、消息去重、直播开播文案生成与 LLBot 投递；附带上游 `compose.yaml` 模板及事件补丁 [`patch-live-notify.mjs`](../integrations/bilibili-notify/patch-live-notify.mjs)。 | 部署并登录你自己的 `bilibili-notify` 服务，配置本地管理面板、共享 Webhook 密钥及关注列表。将面板环境变量保存在 `$ONEBOT_CONFIG_ROOT/secrets/bilibili-notify.env`，并通过 `BILIBILI_NOTIFY_ENV_FILE` 传给 Docker Compose（打补丁前请确认与上游版本匹配）。 |
| **X (Twitter) 媒体解析**<br>[`integrations/x-media/bridge.py`](../integrations/x-media/bridge.py) | 公开推文链接解析、图片与视频下载校验、合并发送，以及只读的 Python 查询桥接脚本。 | 准备独立的 Python 虚拟环境并安装 [`integrations/x-media/requirements.lock`](../integrations/x-media/requirements.lock)。如需查询受限内容，需自行准备账号库，并在 `onebot-x.json` 中配置 `python`、`bridge` 和 `accountsDb` 的绝对路径。 |
| **小红书与 Agent Reach**<br>[`src/src/features/xhs.js`](../src/src/features/xhs.js)<br>[`src/src/xhs/`](../src/src/xhs/)<br>[`integrations/agent-reach/`](../integrations/agent-reach/) | HTTP 客户端、笔记与媒体提取工作流、业务工具封装、请求来源归属校验，以及可选的 Agent Reach 适配层。 | 准备独立的数据目录并完成账号登录（触发验证码或二次验证时需在自有环境手动处理）。<br>• **浏览器模式**：需安装兼容的 Chromium 与 Playwright Core。<br>• **Reach 模式**：需额外部署 Agent Reach 服务及专用系统用户（当前默认读取用户 `openclaw-reach`、主目录 `/var/lib/openclaw-agent-reach`、入口 `/opt/openclaw-agent-reach/xhs-command`）。 |
| **ALAS 与外部脚本通知**<br>[`scripts/deliver.mjs`](../scripts/deliver.mjs)<br>[`integrations/alas/`](../integrations/alas/) | 供外部脚本调用的文本与截图投递脚本（[`send-text.sh`](../integrations/alas/send-text.sh)、[`send-image.sh`](../integrations/alas/send-image.sh)），通过受控的本地接口按服务身份和目标白名单核对后投递。 | 自行部署 ALAS，并在 `onebot-services.json` 中完成服务登记。在 `$ONEBOT_CONFIG_ROOT/secrets/onebot-delivery.key` 放置投递密钥，同时通过环境变量 `ALAS_SCREENSHOT_TARGET_QQ` 指定接收通知的目标 QQ。 |
| **群虚拟股市**<br>[`integrations/sharemarket/`](../integrations/sharemarket/) | 独立的 Python 虚拟市场服务进程、SQLite 存储、Unix Socket 通信接口、QQ 侧交易指令工具，以及行情图与帮助卡渲染代码。 | 准备独立的 Python 环境（推荐 Python 3.12），按 [`requirements-lock.txt`](../integrations/sharemarket/astrbot_plugin_sharemarket/requirements-lock.txt) 安装依赖；参照 [`onebot-sharemarket.example.json`](../integrations/sharemarket/onebot-sharemarket.example.json) 配置持久化数据目录和绑定的 QQ 群。 |
| **提醒、语音与绘图**<br>[`src/src/features/reminders.js`](../src/src/features/reminders.js)<br>[`scripts/transcribe-voice.py`](../scripts/transcribe-voice.py)<br>[`scripts/ai-image-http.mjs`](../scripts/ai-image-http.mjs) | 对话内定时提醒、文字/媒体延迟投递、Whisper 语音转写调用入口、TTS 语音合成及 AI 绘图工具适配层。 | • **对话提醒**：在 `onebot-features.json` 与 `onebot-executors.json` 中开启对应权限即可。<br>• **语音转写**：需在本地安装 FFmpeg、Python、Whisper 及对应的语音识别模型权重。<br>• **TTS 与绘图**：需自行接入兼容的推理接口、模型及经过授权的角色参考图素材。 |

## 3. 外部工作区技能与未随仓库分发的私有脚本

在 [`src/src/features/catalog.js`](../src/src/features/catalog.js) 的工具注册表中，还保留了 **QQ 空间（Qzone）**、**qBittorrent 下载管理**、**ADS-B 航班查询**等机主自用工具的名称定义、参数校验和审批入口。本仓库不包含这些工具的具体实现脚本；如果你需要启用它们，可以按照 `catalog.js` 中声明的相对路径，在 `$ONEBOT_CONFIG_ROOT/workspace/skills/` 下自行放置对应的可执行脚本（例如 QQ 空间对应 `qzone-ops/scripts/qzone-cli.mjs`）。

此外，作者自用的服务器巡检与宿主机维护命令、个人脚本工作区、短信验证码转发以及私有账号登录恢复流程等强耦合个人基础设施的内容，均已从本开源版本中剥离，仅保留了通用的审批流、会话绑定和安全投递框架。
