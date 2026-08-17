# delivery 扩展 - 用户使用说明

## 这是什么

delivery 是一个 omp `session_stop` 钩子扩展。AI 编码代理完成任务时，delivery 会自动评审其证据，判断任务是否真正完成；未完成则自动续跑。

## 适用场景

- 长时运行的开发任务（涉及多轮工具调用）
- 需要验证证据齐全度（测试/构建输出）才能确认完成
- 避免 AI 代理空转或提前宣布"完成"

不适合：短对话、纯问询、非编码任务。

## 快速开始

### 1. 安装

**首次安装**（全新部署，`~/.omp/agent/extensions/delivery` 不存在）：

```bash
cp -R delivery ~/.omp/agent/extensions/delivery
```

**更新到新版本**（保留本地 config.json 等修改）：

```bash
# 用 rsync 排除 config.json（推荐）
rsync -a --exclude='config.json' delivery/ ~/.omp/agent/extensions/delivery/
```

或手动备份恢复：

```bash
# 先备份
cp ~/.omp/agent/extensions/delivery/config.json /tmp/delivery-config.json.bak

# 清洁替换（先删旧目录避免嵌套）
rm -rf ~/.omp/agent/extensions/delivery
cp -R delivery ~/.omp/agent/extensions/delivery

# 恢复配置
mv /tmp/delivery-config.json.bak ~/.omp/agent/extensions/delivery/config.json
```

**清洁重装**（⚠️ 会重置 config.json 到 shipped 默认——**会丢失你的自定义配置**，仅在配置损坏/不可用时使用）：

```bash
rm -rf ~/.omp/agent/extensions/delivery
cp -R delivery ~/.omp/agent/extensions/delivery
```

下次 `omp` 启动自动加载。

**单实例命令（不安装直接加载，推荐验证 / 避免双重加载）**

在仓库根目录运行：

```bash
omp -p -e delivery/index.ts --no-extensions "你的开发任务"
```

`--no-extensions` 会关闭自动发现，只加载这一个扩展。若已用上面任一方式安装，请勿再重复加 `-e delivery/index.ts`，否则会加载两份并产生重复评审结果。

### 2. 第一次使用

启动一个开发任务，让 AI 代理跑：

```bash
omp -p "在 /tmp/test 目录下创建 hello.txt，写入 'Hello delivery'"
```

session 结束时**默认配置下**（`min_assistant_turns_increment=10`）短任务会 **silent return 不评审**——这是预期的 fail-open 行为（避免短促重复评审噪音）。

**触发评审**（二选一）：

1. 让代理产生 ≥ 10 个 assistant 消息（多步骤任务）
2. 临时设 `min_assistant_turns_increment: 0`（关闭静默门）——编辑 `~/.omp/agent/extensions/delivery/config.json` 把该字段改为 `0`，或 `jq '.min_assistant_turns_increment = 0' ~/.omp/agent/extensions/delivery/config.json > tmp && mv tmp ~/.omp/agent/extensions/delivery/config.json`

**验证是否评审触发**：

session 结束后检查 `~/.omp/agent/sessions/` 下本次会话的 JSONL 文件中是否有 `delivery.review` entry：

- **有 entry** → 评审触发成功。读该 entry 的 `details.reason`（中文）了解评审子进程结论或跳过原因（预算超限 / 模型解析失败 / TUI 未启用等）。
- **无 entry** → 多为**静默门命中**（默认 `min_assistant_turns_increment=10` 时 assistant 消息数不足）。这是预期的 fail-open 行为，不是错误。如确需触发评审，参见上一节"触发评审"。

如果任务真正完成（含写入证据），推送 `delivery.review` 状态 `done`。

### 3. 查看评审结果

评审结果写入 omp 的 session JSONL（在 `~/.omp/agent/sessions/`）。TUI/headless 模式下推送 `[delivery]` 开头的可见消息。

## 评审状态与静默门行为

| 状态 | 含义 | 自动行为 | 是否产生 entry |
|---|---|---|---|
| `done` | 任务真正完成 | session 正常结束 | ✓ |
| `continue` | 任务未完成，代理可继续 | 自动续跑新回合，携带反馈 | ✓ |
| `need_user` | 代理重复空转或缺关键信息 | 等待你决策 | ✓ |
| `fail` | 评审出错 | session 正常结束（fail-open） | ✓ |
| `skip` | 评审被跳过但产生 entry（预算超限 / 无 userInput / 模型解析失败 / TUI 默认未启用） | session 正常结束（fail-open） | ✓ |
| `silent` | 静默门命中：未达 `min_assistant_turns_increment` 阈值 | session 正常结束（不产生 entry、不推送可见消息） | ✗ |

**注**：表中前五种状态都会产生 `delivery.review` entry，`details.reason` 字段为中文可读；`silent`（静默门命中）是单独的预期 fail-open 行为，**不产生任何 entry**——参见"验证是否评审触发"小节。

详见 `delivery/README.md` 的 Fail-open 行为与评审状态映射章节。

## 配置调整

修改 `~/.omp/agent/extensions/delivery/config.json`（如用全局自动发现）或 `delivery/config.json`（如用单实例命令）：

- `review_model`：评审模型（默认 `gpt-5.6-terra:high`）
- `max_trigger_percent`：上下文用量百分比上限（默认 90）
- `min_assistant_turns_increment`：评审触发门槛（默认 10，`0` 关闭）
- `enable_tui_review`：TUI 异步评审（默认 `true`，即 TUI 退出后后台跑）

修改后重启 `omp` 生效。详见 README 配置章节。

## 故障排查

### 没看到评审结果

- 检查 session JSONL：是否有 `delivery.review` entry
- 检查 `~/.omp/agent/extensions/delivery/` 是否安装
- 确认 `omp` 启动时无 `--no-extensions` 之外的扩展冲突

### 重复的评审结果

- 不要同时用全局自动发现 + 单实例 `-e delivery/index.ts`（会双重加载）
- 用单实例时加 `--no-extensions`

### 评审太频繁

- 调高 `min_assistant_turns_increment`（如 20）
- 或设为 `0` 完全禁用评审触发门槛

## 卸载

```bash
rm -rf ~/.omp/agent/extensions/delivery
```

如果用的是单实例命令，移除命令中的 `-e delivery/index.ts --no-extensions` 即可。

## 进阶

详见：

- `delivery/README.md`（开发者文档）
- `docs/delivery-spec.md`（完整 PRD + 验证记录）

