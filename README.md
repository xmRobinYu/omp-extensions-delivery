# delivery — Oh My Pi 任务完成度自动评审扩展

> 在 AI 编码代理完成任务时，自动评审证据判断是否真正完成；未完成自动续跑，让长时任务可收敛到 done。

[![Tests](https://img.shields.io/badge/tests-98%20pass-success)]() [![License](https://img.shields.io/badge/license-MIT-blue)]()

## 这是什么

`delivery` 是 [Oh My Pi (omp)](https://github.com/) 的一个扩展，在 `session_stop` 钩子上自动评审 AI 编码代理的当前任务是否真正完成。

### 痛点

- 长时开发任务中，AI 代理经常**提前宣布"完成"**——但实际缺少关键步骤（写入文件未执行、跑构建未通过、证据缺失）
- AI 总结不可信——只能依据 tool_result 证据判断
- 需要人工在每个 session 结束时 review 才能发现任务未完成
- 短促重复 stop 触发大量无意义评审噪音

### 方案

- **session_stop 自动评审**：每个 session 结束时启动独立评审子进程
- **评审隔离**：评审子进程只读、不修改任何文件、不能跑工具
- **Fail-open**：评审出错/超时/超预算 → 放行 session，不阻塞用户工作
- **静默门**：同一 session_id 累计 ≥ N 个新 assistant 消息才评审，避免短任务噪音
- **自动续跑**：评审返回 `continue` 时自动启动新回合（triggerTurn + deliverAs），携带反馈继续

## 核心设计思路

### Fail-open 优先

任何异常路径都不阻塞 session——评审子进程失败、模型超时、预算超限、TUI 默认未启用，session 都正常结束并 fail-open 放行。delivery 的存在是**增强**而非阻断。

### 五种评审状态 + 行为映射

| 状态 | 行为 |
|---|---|
| `done` | session 正常结束 |
| `continue` | 自动续跑新回合，携带评审反馈 |
| `need_user` | 等待用户决策 |
| `fail` | session 正常结束（评审出错 fail-open） |
| `skip` | session 正常结束（预算/解析/TUI 等 fail-open 但产 entry） |
| `silent` | session 正常结束（静默门命中，**不产 entry 不推送**） |

### 评审隔离

评审通过独立 `omp -p` 子进程启动，与主 session 完全隔离：

- `--no-session --no-skills --no-rules` 隔离 omp 资源
- 子进程无工具访问权限（只读 JSON 作答）
- 子进程失败 fail-open，主 session 不受污染

### 静默门（assistant-turn increment gate）

避免短促重复 `session_stop` 触发无效评审。同一 `session_id` 距上次评审新增 `< N` 个 assistant 消息时 handler silent return（不产 entry、不发可见消息）。默认 `min_assistant_turns_increment=10`，可设为 `0` 关闭。

### Percent-first 预算保护

`max_trigger_percent=90`（默认）优先，`max_trigger_tokens=500000` 兜底。omp 17.3.4 实测 percent 单位 0-100。超限时跳评审产 `skip (budget)` entry + 可见消息。

### 单实例 E2E 验证

`--no-extensions` 禁全局自动发现 + 显式 `-e <delivery/index.ts>` 加载——避免与 `~/.omp/agent/extensions` 同时加载产生**两条** `delivery.review` 行的双重加载 bug。详见 [Verified Evidence (2026-08-16)](docs/delivery-spec.md#verified-evidence-2026-08-16)。

## 快速开始

```bash
# 首次安装（推荐方式 A）
cp -R delivery ~/.omp/agent/extensions/delivery

# 启动开发任务
omp -p "你的开发任务描述"
```

完整安装选项（首次/更新/清洁重装/单实例）+ 故障排查 + 卸载：[**docs/USER_GUIDE.md**](docs/USER_GUIDE.md)。

详细配置字段：[**delivery/README.md**](delivery/README.md) 的配置章节。

完整 PRD + 验证记录：[**docs/delivery-spec.md**](docs/delivery-spec.md)。

## 仓库结构

```
.
├── README.md                  # 本文件（项目总览）
├── .gitignore                 # 排除 node_modules / *.log / e2e-smoke* 等
├── delivery/                  # 扩展源码（指向 ~/.omp/agent/extensions/delivery）
│   ├── README.md              # 开发者文档
│   ├── index.ts               # 扩展入口（session_stop handler）
│   ├── src/
│   │   ├── config.ts          # 配置加载 + 默认值
│   │   ├── package.ts         # 证据打包（gzip+base64）
│   │   ├── reviewer.ts        # 评审子进程隔离 + 解析
│   │   ├── decide.ts          # 五种状态映射
│   │   └── types.ts           # 共享类型
│   ├── test/                  # 单元测试（bun test，5 文件 98 pass）
│   ├── config.json            # shipped 配置（review_model: gpt-5.6-terra:high）
│   └── tsconfig.json
└── docs/
    ├── USER_GUIDE.md          # 用户使用说明（安装/使用/排障）
    └── delivery-spec.md       # 完整 PRD + 验证记录
```

## 开发

### 运行测试

```bash
cd delivery
bun test                    # 单元测试（98 pass / 336 expect）
bunx tsc --noEmit           # 类型检查
```

### 端到端验证

参见 [docs/delivery-spec.md](docs/delivery-spec.md) 的"Verified Evidence (2026-08-16)"章节——含单实例命令、probe/short/long E2E 实测、百分比预算 + 静默门行为验证。

### 设计约束（避免破坏）

- **不修改 omp/session 配置**：delivery 是只读观察者
- **不执行工具**：评审子进程只读
- **不重跑测试**：review 不重做代理工作
- **fail-open 优先**：任何异常放行 session

## 许可证

MIT

## 致谢

- [Oh My Pi](https://github.com/) — 父项目
- 模型：[gpt-5.6-terra](https://) — 默认评审模型
