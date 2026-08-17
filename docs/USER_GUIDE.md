# delivery 扩展 - 用户使用说明

## 这是什么

delivery 是一个 omp `session_stop` 钩子扩展。AI 编码代理完成任务时，delivery 会自动评审其证据，判断任务是否真正完成；未完成则自动续跑。

## 适用场景

- 长时运行的开发任务（涉及多轮工具调用）
- 需要验证证据齐全度（测试/构建输出）才能确认完成
- 避免 AI 代理空转或提前宣布"完成"

不适合：短对话、纯问询、非编码任务。

## 快速开始

### 1. 安装（用户选择其一）

**方式 A：全局自动发现**

```bash
cp -r delivery ~/.omp/agent/extensions/delivery
```

下次 `omp` 启动自动加载。

**方式 B：单实例命令（推荐验证 / 避免双重加载）**

在仓库根目录运行：

```bash
omp -p --extension delivery/index.ts --no-extensions "你的开发任务"
```

`--no-extensions` 会关闭自动发现，只加载这一个扩展。若已用方式 A 安装，请勿再重复加 `--extension`，否则会加载两份并产生重复评审结果。

### 2. 第一次使用

启动一个开发任务，让 AI 代理跑：

```bash
omp -p "在 /tmp/test 目录下创建 hello.txt，写入 'Hello delivery'"
```

如果用方式 B 单实例命令，则执行：

```bash
omp -p --extension delivery/index.ts --no-extensions "在 /tmp/test 目录下创建 hello.txt，写入 'Hello delivery'"
```

session 结束时会自动触发评审。如果任务真正完成（含写入证据），推送 `delivery.review` 状态 `done`。

### 3. 查看评审结果

评审结果写入 omp 的 session JSONL（在 `~/.omp/agent/sessions/`）。TUI/headless 模式下推送 `[delivery]` 开头的可见消息。

## 五种评审结果

| 状态 | 含义 | 自动行为 |
|---|---|---|
| `done` | 任务真正完成 | session 正常结束 |
| `continue` | 任务未完成，代理可继续 | 自动续跑新回合，携带反馈 |
| `need_user` | 代理重复空转或缺关键信息 | 等待你决策 |
| `fail` | 评审出错 | session 正常结束（fail-open） |
| `skip` | 跳过评审（静默门 / 预算 / 配置跳过） | session 正常结束 |

详见 README 五种状态章节。

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

如果用的是单实例命令，移除命令中的 `--extension delivery/index.ts` 即可。

## 进阶

详见：

- `delivery/README.md`（开发者文档）
- `docs/delivery-spec.md`（完整 PRD + 验证记录）

