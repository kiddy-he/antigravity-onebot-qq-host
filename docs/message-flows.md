# 消息流与状态存储

本文档说明一条 QQ 消息从进入服务到完成回复的内部流程、Antigravity CLI 会话的续接机制，以及定时任务与异步推送如何保证投递一致性。

## 1. 消息接收与回复流程

```mermaid
flowchart TD
    W["LLBot WebSocket 事件"] --> K{"事件分类"}
    K -->|"生命周期 / 通知"| M["更新连接状态或记录事件"]
    K -->|"消息事件"| A["校验账号、发送者与群白名单，过滤自身回显和重复消息"]
    A -->|"控制命令 / 审批回复"| B["在对应会话内直接执行命令"]
    A -->|"普通聊天"| Q["合并同一发送者短时间内的连续消息"]
    Q --> R{"聊天场景"}
    R -->|"私聊"| P["定位该账号与发送者的独立会话"]
    R -->|"群聊"| G["根据 @ 目标和群配置匹配角色，定位该群成员的会话"]
    P --> I["解析引用消息、转发内容、媒体附件与用户意图"]
    G --> I
    I --> T{"执行路径"}
    T -->|"纯对话"| C["按任务路由调用模型生成回复"]
    T -->|"需要调用业务工具"| U["校验功能权限与审批状态，执行工具"]
    U --> C
    C --> F["内容审查或改写，按长度拆分为多段消息"]
    F --> H["通过对应账号发回 QQ，记录每段消息的平台回执"]
```

在消息预处理和媒体发送阶段，有几个关键的安全与边界限制：

- **引用消息**（[`src/src/quoted-message.js`](../src/src/quoted-message.js)）：收到带引用的消息时，会调用 OneBot `get_msg` 拉取原消息，并核对原消息是否属于当前会话，防止跨会话读取。
- **合并转发**（[`src/src/forwarded-message.js`](../src/src/forwarded-message.js)）：调用 `get_forward_msg` 展开转发卡片时，会严格限制展开的条数、嵌套深度和总文本体积，避免被超长转发撑爆上下文。
- **语音与附件权限**（[`src/src/gateway.js`](../src/src/gateway.js)、[`src/src/standalone/channel-runtime.js`](../src/src/standalone/channel-runtime.js)）：入站语音校验通过后会交给本地 Whisper 转写；机器人向外发送图片、语音或业务文件前，都会校验文件来源是否已获授权。

## 2. CLI 会话续接与上下文一致性

Antigravity CLI（`agy`）自带原生会话记忆（通过 ACP 的 `session/new` 和 `session/load` 管理）。但机器人实际发到 QQ 上的内容，可能会因为审查改写、CLI 故障降级到备用 API、或者 LLBot 发送失败而与 CLI 自己记住的内容不一致。

为了防止 CLI 的内部记忆和 QQ 里的真实聊天记录脱节，服务采用了**收到回执后再确认（Confirm-on-Receipt）**的机制（见 [`src/src/ai/antigravity-chat.js`](../src/src/ai/antigravity-chat.js) 与 [`src/src/ai/antigravity-sessions.js`](../src/src/ai/antigravity-sessions.js)）：

```mermaid
sequenceDiagram
    participant H as Node.js 服务
    participant S as SQLite (sessions.sqlite)
    participant C as Antigravity CLI (agy)
    participant L as LLBot

    H->>S: 按会话标识与当前代次（generation）认领本轮请求
    alt 上一轮会话已确认，且角色、模型、工具绑定未变
        H->>C: session/load 续接已有会话并提交本轮输入
    else 首次对话、重置过会话，或上一轮未完成确认
        H->>C: session/new 新建会话，注入已确认送达的历史记录
    end
    C-->>H: 返回候选回复与 CLI 会话 ID
    H->>S: 暂存候选回复摘要（状态为待确认）
    H->>L: 发送最终处理后的文本
    L-->>H: 返回 QQ 平台 message_id
    H->>S: 校验实际发出的内容与候选一致后，将该 CLI 会话标记为已确认
```

只要中间发生了回复改写、走了备用模型、或者没有拿到完整的发送回执，该轮 CLI 会话就不会被标记为“已确认”。到了下一轮对话，服务会自动开启一个全新的 CLI 会话，并用 SQLite 里**真正成功发到 QQ 上**的历史消息重新构建上下文。

## 3. 定时任务与异步业务投递

除了被动回复消息，服务还负责定时公告、对话提醒以及外部 Webhook（如 B 站动态推送）的主动投递（见 [`src/src/standalone/cron.js`](../src/src/standalone/cron.js)、[`src/src/delivery/queue.js`](../src/src/delivery/queue.js)、[`src/src/features/reminders.js`](../src/src/features/reminders.js)）：

```mermaid
flowchart TD
    S["SQLite 调度器扫描到期任务"] --> A["调用 Agent 生成定时播报"]
    S --> B["执行已登记的固定脚本命令"]
    S --> C["Heartbeat 巡检工作区任务"]
    A --> D["核对服务身份与目标白名单，登记发送尝试"]
    D --> L["通过 LLBot 发送并获取回执"]
    L --> E["写入定时投递记录"]
    B --> F["记录脚本与巡检执行结果"]
    C --> F

    R["对话提醒到期"] --> G["校验原始会话目标与功能权限"]
    W["通过认证的外部业务 Webhook"] --> G
    G --> O["进入业务投递队列，按原账号身份逐段发送"]
    O --> K{"是否拿到全部段落的回执？"}
    K -->|"是"| Y["标记投递完成，更新业务状态"]
    K -->|"超时或中断"| N["保留投递流水号与已成功段落，等待后续核对，避免无脑重发"]
```

## 4. 运行期 SQLite 数据库一览

所有运行状态都保存在 `$ONEBOT_CONFIG_ROOT/state/` 目录下，按职责拆分为多个 SQLite 文件：

| 相对路径 | 用途 |
|---|---|
| `state/standalone/transcript.sqlite` | 保存 QQ 私聊与群聊的实际收发消息记录（用于重建上下文） |
| `state/antigravity/sessions.sqlite` | 维护 QQ 会话到 `agy` 原生会话 ID 的映射、代次（generation）及确认状态 |
| `state/standalone/schedules.sqlite` | 定时任务定义、触发时间与任务认领锁 |
| `state/business/cron-delivery.sqlite` | 定时播报的每次发送尝试与 LLBot 平台回执记录 |
| `state/business/operations.sqlite` | 业务工具执行记录、高危操作审批单、对话提醒以及异步分段投递队列 |
