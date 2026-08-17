# Delivery Extension — PRD + Execution Spec

状态: Verified/Ready（已实现；中文本地化；percent 优先预算（默认 90% / 500k 兜底）；assistant-turn 静默门（默认 N=10）；单实例 E2E 完成；silent gate 实测验证；验证记录见 "Verified Evidence (2026-08-16)"）
日期: 2026-08-16

## Converge

```text
Goal:            session_stop 时判定 agent 的 dev 任务是否真正完成；未完成自动续跑；需要决策时通知用户
Non-goals:       review 不执行工具、不重跑测试、不改代码；delivery 不修改任何配置
Users / actors:  omp 用户（开发任务发起者）；delivery 扩展（只读观察者）；review agent（隔离只读评审）
Constraints:     session 隔离；不修改 config；review 子进程同样隔离；预算上限；最终 summary 不可信
Known context:   探针已验证 11 项 API 事实（session_stop 触发、event.messages、continue 续跑循环、
                 pi.exec/sendUserMessage/appendEntry、getContextUsage、models.resolve、
                 --mode=json NDJSON、ctx.hasUI 区分形态）；TUI 退出原因不可区分 → 记录为约束；
                 后续确认：sendMessage(..., { triggerTurn: true, deliverAs: "nextTurn" }) 可在
                 idle 时启动新回合；ctx.setTimeout 为受管后台 timer（teardown 自动清理）；
                 TUI enable_tui_review: true 时评审异步后台执行、不阻塞 session_stop；
                 单实例运行决策（Option B）：验证期发现显式 -e 与全局自动发现
                 （~/.omp/agent/extensions 等）会**双重加载** delivery → 同一 session_stop
                 产生重复 delivery.archive/delivery.review 行，且首条 review 子进程可能撞
                 headless 25s clamp 超时 fail-open 后 harness 再跑第二次评审；
                 正确单实例命令为 --no-extensions -e <path>（禁自动发现、显式仍加载）
Assumptions:     review_model 必须能被 `ctx.models.resolve()` 解析；解析失败按 FR-012 fail-open，不兜底；omp 二进制路径可解析；-p 是主形态
Blocking questions: 无（grill 全闭合）
```

## PRD

### Problem Statement
Agent 在 session 结束时输出的最终 summary 不可信——它可能声称"完成"而实际测试失败、验收未达成。需要独立的只读评审机制，在 `session_stop` 时对照真实证据（messages + tool_results）判断最近一次用户输入（当前 dev 任务）是否真正完成。

### Goals
- G1：session 结束时自动触发独立评审（可配置开关）
- G2：评审依据真实证据（tool_results 中的测试/验证输出），不信任 summary 自述
- G3：未完成 → 自动续跑（`{continue:true, additionalContext}`，带评审反馈）
- G4：需要用户决策 → 通知用户并放行（不阻塞 session）
- G5：预算保护：上下文用量百分比超 `max_trigger_percent`（percent 不可用时回退 `max_trigger_tokens` token 上限）则跳过评审并放行（fail-open）
- G6：评审模型独立可配置（单独配置文件，通过 pi models 解析）
- G7：全程隔离：不修改配置、review 子进程无扩展/无技能/无规则/无 session

### Non-goals
- 评审不执行任何工具、不重跑测试、不修改代码
- delivery 不修改任何 session 配置
- 不提供代码编辑/修复能力
- 不做跨 session 的持久学习/记忆

### Users / Actors
- **用户**：发起 dev 任务，期望"真完成"而非"声称完成"
- **delivery 扩展**：只读观察者，session_stop 时打包证据、调度评审、执行决策
- **review agent**：隔离的只读 LLM 子进程，返回 JSON 判定

### User Stories
1. 作为用户，我希望 session 结束时自动判定任务是否真完成，以便无人值守时也能收敛到完成态
2. 作为用户，我希望评审依据测试/验证的真实输出，以便不被"我觉得完成了"的 summary 误导
3. 作为用户，我希望未完成时自动续跑并带上评审反馈，以便修复后重新验证
4. 作为用户，我希望需要我决策时得到通知，以便及时介入
5. 作为用户，我希望预算超限时不阻塞退出，以便避免失控烧钱

### Functional Requirements
- FR-001：`session_stop` 时若满足触发条件（-p 形态、预算未超、轮次未满）则打包证据窗口：会话**第一条非空 user 消息**（若已滚出最近 `context_window_messages` 条之外则前置到窗口最前；已在窗口内则不重复，按引用去重）+ **最近 N 条消息**（`context_window_messages`，默认 20）；`userInput` = 窗口内最后一条非空 user 文本，窗口内无 user 文本时回退到第一条非空 user 消息文本；userInput 为空 → 跳过评审并落 skip `no_user_input`（见 FR-016）
- FR-002：打包内容为截断的结构化明文（每条消息 content 截断到 `message_truncate_chars`，总包上限 `package_max_chars`），tool_result 证据文本保留可读
- FR-003：原始消息包以 gzip+base64 压缩后存入 `appendEntry("delivery.archive", …)` 存档（仅存档/日志用途）
- FR-004：证据窗口 = 第一条非空 user 消息（滚出窗口时前置）+ 最近 N 条消息，证据摘要即该窗口的截断明文包（messages + tool_results）；评审 prompt 包含：原始 userInput、证据摘要（明文）、评审标准（summary 不可信 / userInput 是否真达成 / 测试验证须 pass / 仅 tool_result 计证据 / 能力受限不得要求写入 / 明显重复判 need_user）、输出 JSON schema；评审 prompt 与 reason/summary 均为简体中文，禁止英文自然语言
- FR-005：通过 `pi.exec` 启动隔离评审子进程，实际 argv 为 `omp -p --mode=json --model <resolved review_model> --no-session --no-extensions --no-skills --no-rules --thinking=off <prompt>`；prompt 为最后一个位置参数
- FR-006：评审结果 JSON：`{ status: "done"|"continue"|"need_user", reason, summary }`；解析自最后一个 `message_end` 事件的 text；reason/summary 必须为简体中文
- FR-007：`done` → 放行（允许 session 结束），记录评审结论
- FR-008：`continue` → 返回 `{continue:true, additionalContext}` 注入评审反馈，agent 继续
- FR-009：`need_user` → `ctx.ui.notify` 通知 + `appendEntry` + 放行
- FR-010：连续续跑软上限 `max_continue_rounds`（默认 3），超限转 `need_user`
- FR-011：`ctx.getContextUsage().percent > max_trigger_percent`（percent 可用时；不可用回退 `ctx.getContextUsage().tokens > max_trigger_tokens`）→ 跳过评审 + 放行 + 日志（fail-open）
- FR-012：`review_model` resolve 失败 → 跳过评审 + 放行 + 日志（fail-open，不换 fallback）
- FR-013：子进程 spawn/超时/JSON 解析失败 → 放行 + 日志（fail-open）。headless 同步路径超时 clamp 到 25s（受 omp 30s session_stop handler 上限约束，防挂起子进程）；TUI 异步路径使用 `review_timeout_seconds`（默认 60s）不 clamp、且不转发 stop signal
- FR-014：TUI 形态（`ctx.hasUI === true`）默认 `enable_tui_review: false` → 跳过评审、不续跑（fail-open，尊重用户退出意图）；`enable_tui_review: true` 时启用完整评审，但以**异步后台**方式执行：handler 立即返回、不阻塞 session_stop，评审结果到达后再 emit/push/notify；同一会话同一时刻只运行一个评审（in-flight guard，重复 stop 跳过重复评审）
- FR-015：`stop_hook_active === true`（续跑轮）仍触发评审（每轮都评，直至 done/need_user/上限）
- FR-016：所有评审结论落盘：`appendEntry("delivery.review", {round, status, reason, summary, …})` + `pi.logger` + `ctx.ui.notify`；五种状态（done/continue/need_user/fail/skip）都通过 `sendMessage(…, { triggerTurn: false })` 推送可见 `custom_message`（`customType: "delivery.review"`、`display: true`、`attribution: "agent"`，content 为 `[delivery] <中文标签>[: reason]`，有 summary 时追加摘要行）；skip 的 `details.reason` 保持机器可读英文枚举（`tui` / `budget` / `no_user_input` / `model_resolve`，未知原样透传），可见消息按中文渲染（`tui` → TUI 模式未启用评审、`budget` → 上下文预算超限，跳过评审、`no_user_input` → 会话中没有用户输入，无法评审、`model_resolve` → 评审模型解析失败）；done/continue/need_user/fail 的 reason 为评审模型返回的中文，不做映射
- FR-017：TUI 异步评审 `continue` 时额外 push `delivery.continue` custom message（`display: true`，`details` 保留评审字段，`{ triggerTurn: true, deliverAs: "nextTurn" }`）自动续跑新回合；headless 仍由 handler 返回 `{ continue: true, additionalContext }` 交给 harness 续跑
*78|- FR-018：同一 `session_id` 距上次评审新增 `role: "assistant"` 消息数 < `min_assistant_turns_increment`（默认 10）时，`session_stop` handler 在预算检查之前静默返回：不执行评审、不落 `delivery.review`、不发可见消息；门通过时立即在 `state.lastReviewCount` 记录当前 assistant 消息数（即使随后预算检查跳过评审）；计数按 `session_id` 隔离；设 `0` 关闭静默门；session_id 缺失/为空时门不启用，走原评审流程；首次 stop 从 0 计数（last=0），不足 N 时静默返回且不记录基线；历史被压缩导致 assistant 消息数小于上次基线时，重置基线为当前数并静默返回，下次 stop 按新基线判断

### Acceptance Criteria
- AC-001：`omp -p` 运行带 delivery 的 session 结束时，`delivery.review` entry 出现（评审执行或 fail-open 跳过均有记录）
- AC-002：评审返回 `continue` 时，agent 收到 additionalContext 反馈并继续，最终收敛到 `done`（或软上限）
- AC-003：tool_result 中的关键证据字符串（如 "3 failed"、"All tests passed"）在评审 prompt 明文里可读
- AC-004：预算超限时 session 正常结束，无阻塞，日志记录跳过原因
- AC-005：TUI 默认不评审、session 正常结束；`enable_tui_review: true` 后异步评审且不阻塞会话
- AC-006：配置从独立 `config.json` 读取，所有字段有默认值
*87|- AC-007：同一 session_id 的短重复 stop 在新增 assistant 消息数不足 `min_assistant_turns_increment` 时不产生第二条 `delivery.review`；达到阈值后恢复评审；计数按 session_id 隔离；首次 stop 不足阈值静默返回且不记录基线；compaction 缩历史后重置基线并静默返回，之后新增达到阈值再恢复评审；session_id 缺失时门退化原状

### Edge Cases / Failure Handling
- review 子进程超时/崩溃/输出非 JSON → fail-open 放行 + 日志
- 模型 resolve 失败 → fail-open 放行 + 日志
- 消息包为空/无 userInput → 跳过评审 + 日志
- 预算超限 → 跳过评审 + 日志
- 续跑超过软上限 → 转 need_user 通知 + 放行
- 多次续跑后 harness 强制 stop（第 8 次）→ 放行 + 日志
- TUI 后台评审期间再次 session_stop → in-flight guard 只跳过重复评审，不产生第二个子进程
- 同一 session_id 短重复 stop → assistant-turn 静默门静默返回，不产生 delivery.review/可见消息
- 首次 stop 时 last=0，assistant 消息数不足 N → 静默返回且不记录基线
- 历史被压缩（assistant 消息数小于上次基线）→ 重置 lastReviewCount 基线为当前数并静默返回，下次 stop 按新基线判断
- session_id 缺失/为空 → 静默门不启用，走原评审流程
- detached 后台任务必须被 try/catch 包裹（log + fail emit）+ 受管 timer 调度，避免未处理 rejection 打崩会话

### Constraints
- delivery 自身不修改任何 omp/session 配置；review_model/enable_tui_review 等由用户通过独立 config.json 配置
- review 子进程必须 `--no-session --no-extensions --no-skills --no-rules`
- 评审模型通过 `ctx.models.resolve(review_model)` 解析，解析失败不 fallback
- TUI 默认不自动评审；开启后异步评审，不阻塞 session_stop（约束，见 FR-014）

### Out of Scope
- 工具执行、测试重跑、代码修复
- 跨 session 学习/记忆
- 多语言/多用户管理

## Spec

### Goal
在 `omp-extensions/delivery/` 实现 delivery 扩展：session_stop 时打包证据 → 隔离评审 → 按 JSON 判定执行 done/continue/need_user，全程 fail-open、预算保护、模型独立配置。

### Scope
#### In scope
- `index.ts`（扩展工厂 + session_stop handler）
- `src/config.ts`（配置加载/校验/默认值）
- `src/types.ts`（DeliveryCtx/sendMessage options 等共享类型）
- `src/package.ts`（消息打包：截断明文 + gzip 存档）
- `src/reviewer.ts`（prompt 构造、子进程调度、JSON 解析、fail-open）
- `src/decide.ts`（判定映射：done/continue/need_user/上限）
- `config.json`（独立配置）
- 98 个单元测试（5 个文件）+ probe/short/long 三场单实例 E2E（验证记录见 Verified Evidence (2026-08-16)）
- `README.md`（注册说明 + 约束记录）

#### Out of scope
- 任何工具执行/测试重跑/代码修改能力
- 配置修改
- 跨 session 持久化学习

### Relevant Context
- 探针已验证事实（见 Converge Known context）
- review 子进程输出为 NDJSON 事件流，取最后一个 `message_end` 的 `message.content[].text`
- `{continue:true}` 上限 8 次（harness 强制）；软上限 3 次（本扩展）
- 工作目录为空 repo；omp 二进制 `omp`（默认 PATH 解析，可用 OMP_BIN 覆盖）

### Terms / Assumptions
- **fail-open**：任何失败（spawn/超时/解析/模型 resolve/预算 percent 或 tokens 超限）→ 允许 session 结束 + 日志，绝不阻塞
- **TUI 约束**：TUI 默认 `enable_tui_review: false` 不自动评审（退出原因不可区分，尊重用户退出意图）；开启后异步后台评审，不阻塞 session_stop
- **续跑轮**：`stop_hook_active === true` 表示续跑产生的 session_stop
- **单实例运行（Option B）**：验证 E2E 使用 `--no-extensions -e <path>`——`--no-extensions` 禁用扩展自动发现、显式 `-e` 仍加载，保证恰好一个 delivery 实例
- **双重加载教训**：显式 `-e` 与全局自动发现（`~/.omp/agent/extensions` 等）同时生效会加载两个 delivery 实例 → 同一 session_stop 产生重复 delivery.archive/delivery.review 行、首条 review 子进程可能超时 fail；复现验证必须用单实例命令
- 假设：`review_model` 必须能被 `ctx.models.resolve()` 解析；解析失败按 FR-012 fail-open，不兜底

### Affected Surfaces
- Code: `delivery/` 新增目录
- Data / schema: 无持久化 schema 变更（仅 `appendEntry` 持久化评审记录）；新增 TUI 异步 `delivery.continue` custom message（triggerTurn:true, deliverAs:nextTurn）
- API / CLI / UI: 无（纯观察者，不新增命令）
- Tests: 单元测试（打包/reviewer/decide/预算/上限）+ E2E 冒烟
- Docs / ops: `README.md`（注册 + 约束）

### Technical Direction
```
session_stop(event, ctx)
 ├─ ctx.hasUI === true && !cfg.enable_tui_review → log skip + return（FR-014 默认）
 ├─ ctx.hasUI === true && state.reviewInFlight → log skip + return（in-flight guard）
 ├─ assistant-turn 增量 < min_assistant_turns_increment → 静默 return
 │   （无 delivery.review entry/可见消息；门通过立即记录 lastReviewCount[session_id]；
 │     首次 last=0 从 0 计数；compaction 缩历史 → 重置基线并静默 return；
 │     session_id 缺失 → 门不启用走原评审）
 ├─ getContextUsage().percent > max_trigger_percent（percent 不可用时回退
 │   getContextUsage().tokens > max_trigger_tokens）→ log skip + return
 ├─ 取 event.messages：第一条非空 user 消息（若已滚出最近 context_window_messages 条
 │   则前置到窗口最前，按引用去重、不重复）+ 最近 context_window_messages 条消息（FR-001）；
 │   userInput = 窗口内最后非空 user 文本（无则回退第一条非空 user 文本；为空 → skip no_user_input）
 ├─ package.ts: 截断明文（每条 ≤ message_truncate_chars，总 ≤ package_max_chars）
 │              + gzip/base64 存档包（appendEntry delivery.archive）
 ├─ models.resolve(review_model) 失败 → log skip + return
 ├─ 构造 argv：omp -p --mode=json --model <id> --no-session --no-extensions
 │             --no-skills --no-rules --thinking=off <prompt>（prompt 为最后一个位置参数）
 ├─ 分支（isTui）：
 │   headless（同步）→ runReview(timeout=min(review_timeout_seconds*1000, 25_000),
 │                        signal=event.signal)
 │   TUI（异步后台）→ 立即 return；state.reviewInFlight=true；
 │                    timeout=review_timeout_seconds*1000（不 clamp、不转发 signal）；
 │                    ctx.setTimeout(() => run(), 0) 调度后台任务（无则直接 run()），
 │                    run() 内 try/catch 兜底 + finally 复位 reviewInFlight
 ├─ 解析失败/超时 → log + return（fail-open）
 ├─ decide.ts（headless 与 TUI 语义一致）:
 │   status=done      → appendEntry(review) + notify + return（放行）
 │   status=continue  → rounds < max_continue_rounds
 │                       → appendEntry + (headless: return {continue:true, additionalContext}
 │                                        TUI: push delivery.continue {triggerTurn:true,
 │                                             deliverAs:"nextTurn"} 自动续跑)
 │                     else → need_user 路径
 │   status=need_user → appendEntry + notify + return（放行）
```

### Validation Plan
- VAL-001: 打包逻辑，Surface: domain，Evidence: 单元测试——截断边界、总量上限、tool_result 证据字符串在明文可读、gzip 包可解压回原文、第一条非空 user 消息滚出窗口时前置（长会话 userInput 回退到第一条 user 文本）、已在窗口内时不重复（按引用去重）、存档包解压回窗口原文案（archive round-trip）
- VAL-002: review JSON 解析，Surface: domain，Evidence: 单元测试——正常/畸形/空输出/超时 → fail-open
- VAL-003: 判定映射，Surface: domain，Evidence: 单元测试——done/continue/need_user/软上限 → 正确动作
- VAL-004: 预算检查，Surface: domain，Evidence: 单元测试——percent 存在时按 `percent > max_trigger_percent`（严格大于，90 恰好等于不跳）；percent 为 undefined/NaN/Infinity 时回退 tokens 边界（500000 不跳、500001 跳）；超限跳过 + 日志
- VAL-005: E2E 冒烟，Surface: business-flow，Evidence: 真实 `omp -p` 带 delivery 跑完成场景——`delivery.review` entry 出现且 status=done **仅当 assistant 消息数累计 >= `min_assistant_turns_increment`（默认 10）时**；短任务（A<N）由静默门 silent return，不产生 delivery.review/visible
- VAL-006: TUI 异步评审，Surface: domain，Evidence: 单元测试——handler 立即返回、drain 后结论可见（done/fail/notify）、continue 通过 delivery.continue + triggerTurn 续跑、in-flight guard 只跑一次 exec、异步超时不 clamp（60s → 60_000ms）、不转发 stop signal
- VAL-007: skip 可见消息，Surface: domain，Evidence: 单元测试——done/continue/need_user/fail/skip 五种状态均推送 delivery.review 可见 custom_message（triggerTurn:false）；skip 的 details.reason 保持英文枚举而可见文案中文（tui/budget/no_user_input/model_resolve 及未知透传）；渲染器状态色/摘要折叠/宽度裁剪
- VAL-008: 单实例 E2E 验证，Surface: business-flow，Evidence: 真实 `omp -p --no-extensions -e delivery/index.ts` 运行（2026-08-16 live E2E）：
  - **短任务**（prompt "pwd && ls" 实测 2 assistant 消息）：**静默门命中，0 条 delivery.archive / 0 条 delivery.review / 0 条 visible**
  - **长任务**（prompt 强制每回复一次 echo 1..10，实测 11 assistant 消息 review 前）：**静默门通过 1 次，1 条 delivery.archive + 1 条 delivery.review (status=done) + 1 条 visible**
  - rc=0 / 自然结束未被 timeout 杀；JSONL 与 stdout 日志路径记录（详见 "Verified Evidence (2026-08-16)"）
  - **历史标签**：本节此前 "probe/short 都 1 archive + 1 review" 的描述来自 8-16 静默门启用前的 session_stop 模型；当前默认配置下短任务不评
*198|- VAL-009: assistant-turn 静默门，Surface: domain，Evidence: 单元测试——不足阈值静默返回不产生第二条 review；足够新增 turn 后恢复；门通过记录早于预算跳过；按 session_id 隔离；`0` 关闭；首次 stop 不足阈值静默且不记录基线；compaction 缩历史重置基线并静默返回，之后新增达到阈值再恢复评审；session_id 缺失时门退化原状

### Verified Evidence (2026-08-16)

验证记录来源：`<verification-log>`（静默门启用前历史）+ 静默门启用后 live E2E 补充段（2026-08-16 静默门上线后实测）。Section 8/9 是静默门启用前**历史**结论；当前默认配置下短任务静默命中（详见下段"静默门启用后 live E2E 补充"）。

- **bun test**（Section 1）：`bun test v1.3.14`，98 pass / 0 fail / 336 expect() calls（5 个文件），EXIT=0（含 assistant-turn 静默门新增测试）
- **tsc**（Section 2 + 静默门复验）：`bunx tsc --noEmit` EXIT=0
- **静默门变更复验（2026-08-16）**：`bun test` 98 pass / 0 fail / 336 expect；`bunx tsc --noEmit` EXIT=0；已重跑 live E2E 验证短任务 A=2 静默命中 0/0/0 与长任务 A=11 通过 1/1/1（详见下段"静默门启用后 live E2E 补充"）；含首次不足阈值、compaction 静默重置 + session_id 缺失退化测试
- **repo ↔ 安装目录 cmp**（Section 3 + 总结）：14/14 文件一致（index.ts、src/config.ts、src/decide.ts、src/package.ts、src/reviewer.ts、src/types.ts、README.md、config.json、package.json、bun.lock、tsconfig.json、REVIEW_ARGV_PROBE.md、e2e-smoke.json、e2e-smoke2.json）；`package.json` 相同，版本保持 1.0.0 未变
- **`--no-extensions` 语义**（Section 7，`omp --help` RC=0）：`-e, --extension=<value>` 可多次加载扩展文件；`--no-extensions` = Disable extension discovery (explicit -e paths still work)——禁用扩展自动发现，显式 `-e` 仍加载
- **根因（双重加载）**：显式 `-e` 与全局自动发现（`~/.omp/agent/extensions`）同时加载 delivery → 同一 session_stop 产生**两条** `delivery.archive` + **两条** `delivery.review`（早前短/长 E2E：review rows=3、archive rows=2）；长会话中首条 review 子进程撞 headless 25s clamp/上游超时 → `status=fail, reason=timeout` fail-open（FR-013），harness 再跑第二次评审成功（`FINAL_REVIEW_STATUS=done`）
- **正确单实例命令**：`omp -p --mode=json --thinking=off --no-extensions -e <delivery/index.ts 路径> --model <review_model> "<prompt>"`（`--no-extensions` 禁自动发现 + 显式 `-e` 加载，恰好一个 delivery 实例）
- **单实例探针**（Section 7.1）：rc=0, elapsed=35.83s；stdout `/tmp/delivery-single-probe.log`；JSONL `<session-jsonl-path>`；delivery.archive=1、delivery.review=1（status=done）、可见消息=1；archive 4 条消息（roles user/assistant/toolResult/assistant）
- **短会话单实例 E2E**（Section 8）：rc=0, elapsed=26.19s；stdout `/tmp/delivery-short-e2e-single.log`；JSONL `<session-jsonl-path>`；delivery.archive=1（archive_msg_count=4，首条 user prompt=运行 pwd 和 ls，然后回复 DONE_VERIFY）、delivery.review=1（status=done, round=1）、可见消息=1
- **长会话单实例 E2E**（Section 9）：rc=0, elapsed=132.47s（自然结束，timeout 1800s 未触发）；stdout `/tmp/delivery-long-e2e-single.log`；JSONL `<session-jsonl-path>`；delivery.archive=1（archive_msg_count=21，roles=user,toolResult,assistant×10,assistant，首条 user prompt=用 bash 依次运行 echo 1 到 echo 10…）、delivery.review=1（status=done, round=1，reason 确认十次 bash 调用均输出 1–10）、可见消息=1；无 fail/timeout 行
- **E2E 结论**（静默门启用前历史）：PASS——短/长单实例各恰好 1 条 archive + 1 条 review（status=done），长会话自然结束 ~132s 未被 timeout 杀。注：此为静默门上线前数据；当前默认 N=10 下短任务静默命中不评（详见下段）
- **静默门启用后 live E2E 补充**（2026-08-16 静默门上线后实测）：
  - 短任务 A=2：静默命中 0 archive / 0 review / 0 visible（默认 N=10）
  - 长任务 A=11：静默门通过 1 次，1 archive + 1 review (done) + 1 visible
  - 含义：默认配置下短任务不再产生 delivery.review/visible；评审只在累计 N 个新 assistant 消息后触发

### Risks / Open Questions
- TUI 退出原因不可区分 → 已记录为约束（FR-014）
- 上游模型代理曾挂起 >35s；headless 25s clamp 会 fail（fail-open 放行），TUI 异步不再阻塞但结果可能迟到或超时；当前 review_model=otokapi/gpt-5.6-terra:high，建议监控响应稳定性
- `pi.exec` 环境继承 → 子进程需 `--no-*` 全套隔离参数

### Mission Handoff
- 2026-08-16 已完成：M1–M4（打包/配置单元测试、reviewer/decide 单元测试、短会话 E2E、README 与验证记录）
- 复现命令与证据见 Verified Evidence (2026-08-16)
- 人工门：无（全部自动验证）

## Readiness

```text
Readiness: Verified/Ready
Reason:   实现完成：证据窗口首条 user 前置 + userInput 回退、五状态 delivery.review 落盘 + 可见消息、中文标签/skip 中文文案、
         percent 优先预算（max_trigger_percent=90，percent 不可用回退 max_trigger_tokens=500000；omp 17.3.4 实测 percent 单位 0-100）、
         assistant-turn 静默门（默认 10，首次不足阈值静默、compaction 重置基线并静默返回、session_id 缺失退化）、
         single-instance E2E (--no-extensions -e) probe/short/long all status=done + silent gate live E2E (A=2 → 0 review; A=11 → 1 review done)；
         bun test 98 pass / 336 expect, tsc, repo↔install cmp 14/14 all green
Next:     使用单实例命令 `--no-extensions -e <path>` 复现（见 "Verified Evidence (2026-08-16)"）；silent gate 默认 N=10 可按需调整（0 禁用）
```
