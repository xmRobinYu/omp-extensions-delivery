# delivery 扩展

## 它做什么

`session_stop` 时对最近一次用户输入（当前 dev 任务）做**独立评审**，不信任 agent 的最终 summary：

- 打包证据：会话**第一条非空 user 消息**（若已滚出最近窗口则前置到最前）+ **最近 N 条消息**（`context_window_messages`，默认 20），连同 tool_results 交给隔离的只读评审子进程
- 评审返回 JSON 判定：
  - `done` — 任务真正完成，放行 session 结束
  - `continue` — 未完成，自动续跑并注入评审反馈（软上限 `max_continue_rounds` 次，超出转 `need_user`）
  - `need_user` — 需要用户决策，通知用户并放行

全程 fail-open：任何失败（预算超限、模型解析失败、子进程超时/崩溃、JSON 解析失败）都允许 session 正常结束并记录日志，绝不阻塞。

## 文件布局

```
delivery/
├── index.ts          # 扩展工厂 + session_stop handler
├── src/
│   ├── config.ts     # 配置加载/校验/默认值（读 config.json，不改任何配置）
│   ├── package.ts    # 消息打包：截断明文 + gzip+base64 存档
│   ├── reviewer.ts   # 评审 prompt 构造、隔离子进程调度、JSON 解析、fail-open
│   └── decide.ts     # 判定映射：done / continue / need_user / 软上限
├── config.json       # 独立配置（所有字段有默认值）
└── test/             # 单元测试（打包/reviewer/decide/预算/上限/静默门）+ E2E 冒烟
```

## 配置

| 字段 | 代码 fallback | 说明 |
|---|---|---|
| `review_model` | `deepseek-proxy/deepseek-v4-flash` | 评审模型标识，经 `ctx.models.resolve()` 解析；解析失败不换 fallback |
| `max_trigger_percent` | `90` | 上下文用量百分比（0–100）超此值跳过评审；percent 不可用时回退 `max_trigger_tokens` |
| `max_trigger_tokens` | `500000` | percent 不可用时的兜底上限（默认 500000） |
| `max_review_tokens` | `10000` | 评审子进程输出上限（提示性，由 prompt 约束） |
| `context_window_messages` | `20` | 证据窗口大小：最近 N 条消息；会话第一条非空 user 消息若不在窗口内会前置到最前（不重复） |
| `enable_compression` | `true` | 是否对存档包做 gzip+base64 压缩 |
| `enable_tui_review` | `false` | TUI 会话是否启用**异步后台**归档+评审+续跑流程；`true` 时覆盖 FR-014 默认跳过 |
| `review_timeout_seconds` | `60` | 评审子进程超时（秒）；超时 fail-open（TUI 异步评审直接用此值，不再 clamp 到 25s） |
| `max_continue_rounds` | `3` | 连续续跑软上限；超出转 `need_user` |
| `min_assistant_turns_increment` | `10` | 同一 session_id 距上次评审新增 assistant 消息数不足此值时静默跳过评审；`0` 关闭静默门；session_id 缺失时门不启用 |
| `message_truncate_chars` | `8000` | 明文包中每条消息 content 截断字符数 |
| `package_max_chars` | `100000` | 明文包总大小上限（字符） |

**配置覆盖**：仓库自带的 `config.json` 是 shipped override——以下字段与代码 fallback 不同：

| 字段 | 代码 fallback（src/config.ts） | shipped config.json |
|---|---|---|
| `review_model` | `deepseek-proxy/deepseek-v4-flash` | `otokapi/gpt-5.6-terra:high` |
| `enable_tui_review` | `false` | `true` |

clone 后实际加载的是 `config.json`（如存在）→ shipped 行为；删除 `config.json` 或修改字段可切回 fallback。其它未列字段均无差异。

## 静默门

为避免短促重复的 `session_stop` 触发无效评审，同一 `session_id` 距上次评审新增的 `role: "assistant"` 消息数小于 `min_assistant_turns_increment`（默认 10）时，handler 静默返回：不执行评审、不落 `delivery.review`、不发可见消息。门在预算检查之前执行；门通过会立即记录当前 assistant 消息数，即使随后预算检查跳过评审。设 `0` 可关闭此门。session_id 缺失/为空时门不启用，走原评审流程；首次 stop 从 0 计数，assistant 消息数不足 N 时静默返回且不记录基线；若历史被压缩导致 assistant 消息数小于上次基线，则重置基线为当前数并静默返回，下次 stop 按新基线判断。

## 注册

- **自动发现**：把 `delivery/` 放入 `<cwd>/.omp/extensions` 或 `~/.omp/agent/extensions`
- **显式指定（推荐单实例）**：`omp --extension delivery/index.ts --no-extensions`。`--no-extensions` 禁用扩展自动发现，而显式 `-e` 仍会加载，确保恰好加载一个 delivery 实例。注意：仅用 `-e` 而**不加** `--no-extensions` 时，若 delivery 同时位于全局自动发现目录（如 `~/.omp/agent/extensions`），会被加载两次 → 同一 `session_stop` 产生重复的 `delivery.archive` / `delivery.review` 行（2026-08-16 E2E 实测）。
- **settings 配置**：在 `extensions:` 数组中列出入口路径

## E2E 验证注意

验证 delivery 的 E2E 必须使用单实例命令（2026-08-16 实测；`--no-extensions` 禁用扩展自动发现，显式 `-e` 仍加载，恰好一个 delivery 实例）：

```
omp -p --mode=json --thinking=off --no-extensions -e <delivery/index.ts 路径> --model <review_model> "<prompt>"
```

- **短会话**（"运行 pwd 和 ls，然后回复 DONE_VERIFY"）：实测 assistant 消息数仅 2 < 静默门默认 N=10，**静默命中：0 条 `delivery.archive`、0 条 `delivery.review`、0 条可见消息**（handler silent return）。此为默认配置下的预期行为；若需对短任务也评审，设 `min_assistant_turns_increment: 0` 关闭静默门。
- **长会话**（强制每次回复一个 echo 以保证 assistant 消息数 >= N）：实测 assistant 消息数 11（review 前 10 + 末次 stop）>= 静默门默认 N=10，**静默门通过一次**：1 条 `delivery.archive` + 1 条 `delivery.review`（status=done）+ 1 条可见消息，无 fail/timeout 行。注：原 "echo 1 到 echo 10" prompt 因模型 batch 多次 echo 为单个 assistant 回复，实测仅 2 assistant 消息（落入静默门）——长任务验证需 prompt 显式禁止 batching（如"每次回复只运行一个 bash 命令"）。
- 结论（2026-08-16 静默门启用后实测）：单实例运行时默认配置下（A<10 silent；A>=10 review）评审触发由 `min_assistant_turns_increment` 门控；早前不带 `--no-extensions` 的会话出现重复行（`-e` 与全局自动发现双重加载）仍适用。`--no-extensions -e` 单实例命令是 E2E 与日常使用的推荐形式。

## 使用方式

- **headless `omp -p`**：主形态。session 结束时自动触发独立评审；返回 `continue` 时自动续跑并携带评审反馈，直到收敛到 `done`（或 `need_user` / 软上限）。
- **TUI（`ctx.hasUI === true`）**：默认**不**自动评审、**不**续跑（FR-014，fail-open，尊重用户退出意图）。配置 `"enable_tui_review": true` 后启用**异步后台评审**：`session_stop` handler 立即返回、不阻塞退出；评审在后台执行，超时用 `review_timeout_seconds`（不受 headless 的 25s clamp 限制，也不转发 stop signal）；结果到达后推送 `delivery.review` 可见消息；`continue` 时额外推送 `delivery.continue`（`triggerTurn: true` + `deliverAs: "nextTurn"`）自动续跑新回合；同一时刻只运行一个评审（in-flight guard，重复 stop 不产生重复评审）。

## Fail-open 行为

以下情况均允许 session 正常结束并记录日志（跳过评审，不阻塞）：

- `getContextUsage().percent > max_trigger_percent`（percent 不可用时回退 `getContextUsage().tokens > max_trigger_tokens`，预算超限）
- `review_model` resolve 失败（不换 fallback）
- 评审子进程 spawn 失败 / 超时（`review_timeout_seconds`）/ 输出非 JSON

## 评审子进程隔离

评审通过 `pi.exec` 启动隔离子进程：

```
omp -p --mode=json --model <resolved review_model> --no-session --no-extensions --no-skills --no-rules --thinking=off <prompt>
```

prompt 是最后一个位置参数。

无 session、无扩展、无技能、无规则；评审只读，不执行工具、不重跑测试、不改代码。

## 明文 vs 存档

- **评审模型读取**：截断后的结构化**明文**包（每条消息 ≤ `message_truncate_chars`，总包 ≤ `package_max_chars`），tool_result 证据文本保持可读。
- **gzip+base64 存档包**：经 `appendEntry("delivery.archive", …)` 落盘，**仅审计/日志用途**，绝不发给模型。

## 评审结论可见消息

评审结论现在以 `custom_message` 推送进会话消息流：

- `customType: "delivery.review"`，`display: true`，`attribution: "agent"`，`content` 为 `[delivery] <标签>[: 原因]`（含摘要时追加摘要行），`details` 保留完整评审字段。
- 所有可见文案与评审返回的 `reason`/`summary` 均为简体中文；状态标签映射：`done` → 评审完成、`continue` → 评审：继续、`need_user` → 需要你确认、`fail` → 评审失败、`skip` → 评审跳过（未知状态 fallback → 评审）。
- `done` / `continue` / `need_user` / `fail` / `skip` 五种状态都推送可见消息（`customType: "delivery.review"`）。skip 的 `details.reason` 保持机器可读的英文枚举（`tui` / `budget` / `no_user_input` / `model_resolve` 等），可见消息的 reason 渲染为中文：`tui` → TUI 模式未启用评审、`budget` → 上下文预算超限，跳过评审、`no_user_input` → 会话中没有用户输入，无法评审、`model_resolve` → 评审模型解析失败；未知 reason 原样显示。`done`/`continue`/`need_user`/`fail` 的 reason 是评审模型返回的中文，不做映射。
- 推送使用 `pi.sendMessage(…, { triggerTurn: false })`，只在事件处理中发生，不触发新回合。
- TUI 异步 `continue` 时额外推送 `delivery.continue`（`display: true`，`content` 为评审反馈，`details` 保留评审字段）并带 `{ triggerTurn: true, deliverAs: "nextTurn" }`，自动恢复一个新回合；headless 不受影响（仍由 handler 返回值续跑）。
- 扩展工厂在 load 阶段注册 `delivery.review` 渲染器：TUI 中显示 `[delivery]` 徽标和状态色（done 绿 / continue 强调色 / need_user 黄 / fail 红），原因与摘要按宽度裁剪，折叠时不显示摘要；零依赖，不导入 `@oh-my-pi/pi-tui`。
- TUI 模式默认按 FR-014 跳过自动评审；`enable_tui_review: true` 后评审在后台异步执行，可见消息与渲染器同样作用于 TUI。

## 约束

- delivery 自身从不修改任何 omp/session 配置；review_model 等扩展参数由用户通过 `delivery/config.json` 配置。
- 纯只读观察者：不执行工具、不重跑测试、不修改代码、不做跨 session 学习。
- 评审结论落盘：`appendEntry("delivery.review", {round, status, reason, summary, …})` + 可见 `custom_message`（done/continue/need_user/fail/skip 状态都推送）+ `pi.logger` + `ctx.ui.notify`。
