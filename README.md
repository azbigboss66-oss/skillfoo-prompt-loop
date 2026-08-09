# SkillFoo Prompt Loop CLI

一个本地命令行工具：用户提供原始 Prompt、业务 Goal 和模型 API 配置；SkillFoo 自动生成测试题、审计题目质量、隔离 Holdout，并循环执行评测、badcase 修复、候选比较与发布回滚。

SkillFoo 不是通用 Agent 平台，不包含 Web UI、数据库、账号体系或云端运行时。

## 它解决什么问题

对同一份业务 Prompt，SkillFoo 会先记录基线表现，再用公开集寻找可修复的 badcase，生成候选 Prompt 并比较结果。候选即使总分提升，只要出现关键安全退步、范围膨胀或 Holdout 退步，也会被拒绝或回滚。

它能证明的是：在给定 Goal、测试集与 Holdout 上，新 Prompt 比原 Prompt 更好且没有严重退步。它不宣称存在全场景的“满分 Prompt”。

## 环境要求

- Node.js 20 或更高版本
- npm
- 一个兼容 OpenAI Chat Completions 的文本模型 API

## 三分钟开始

```powershell
npm install
npm run build
node dist/cli.js init .\my-project --base-url https://api.example.com/v1 --model your-model-name
```

在 `my-project\.env` 填入真实 API Key，在 `prompt.md` 写原始 Prompt，在 `goal.md` 补充业务目标和边界。随后运行：

```powershell
node dist/cli.js doctor .\my-project
node dist/cli.js provider-check .\my-project
node dist/cli.js auto-loop .\my-project --test-count 12 --holdout-count 4 --max-iters 2
```

第一次建议使用 `12` 条公开题和 `4` 条 Holdout，控制费用与等待时间。业务方向确认后，可用 `20 + 6` 再做一次正式验收。

## 首次输入与自动出题

首次运行只需准备三项：

| 输入 | 用途 |
|---|---|
| `prompt.md` | 原始 Prompt，不要求一开始写得很好 |
| `goal.md` | 业务目标、可做/不可做、高风险情况、澄清规则和输出风格 |
| `skillfoo.config.json` + `.env` | 模型 Base URL、模型名和本地 API Key |

`auto-loop` 会根据 Prompt 与 Goal 自动生成测试池、检查重复和风险覆盖，再切分为公开集与 Holdout。公开集用于候选优化；Holdout 只用于最终发布门。

当你已经认可一套题目并想稳定复跑时，再把它保存成 `tests.jsonl` 与 `holdout-tests.jsonl`，使用 `prompt-loop`。这属于进阶模式，不是第一次使用的门槛。

## 通用 API 配置

本版本按协议而不是按厂商名称接入模型。只支持以下通用边界：

- Bearer API Key
- OpenAI Chat Completions 请求路径
- 响应中存在 `choices[0].message.content`

`init` 创建的配置如下：

```json
{
  "provider": {
    "type": "openai-compatible",
    "baseUrl": "https://api.example.com/v1",
    "apiKeyEnv": "SKILLFOO_API_KEY",
    "model": "your-model-name"
  }
}
```

真实 Key 只写入项目内 `.env`：

```text
SKILLFOO_API_KEY=your_api_key_here
```

`baseUrl` 必须停在 `/chat/completions` 之前。若 URL、Key、模型名或响应协议不兼容，项目会明确报错，绝不会静默改用 mock。`provider-check` 只发送一条极短请求验证连通性，不会运行测试或循环。

## 核心命令

| 命令 | 用途 |
|---|---|
| `init <projectDir>` | 创建 Prompt、Goal、通用 API 配置与本地 `.env` 模板 |
| `doctor <projectDir>` | 检查 Prompt、Goal 和 Provider 配置，不调用模型 |
| `provider-check <projectDir>` | 用一条短请求验证 Key、Base URL 和模型名 |
| `auto-loop <projectDir>` | 自动出题、审计、切分、运行优化循环 |
| `prompt-loop <projectDir>` | 用固定公开集与 Holdout 复跑循环 |
| `generate-tests <projectDir>` | 只生成并保存完整测试题与审计材料 |

本地无 API 验收时，可显式指定 mock：

```powershell
node dist/cli.js prompt-loop examples\basic --provider mock
```

## 五文件输出

每次成功运行默认使用 `compact` 模式，在 `runs/<project>/<timestamp>/` 中只留下五个顶层文件：

| 文件 | 用途 |
|---|---|
| `report.md` | 人类可读的分数、时间线、结论和限制 |
| `best-prompt.md` | 唯一可部署的 Prompt；Holdout 回滚时为基线 Prompt |
| `prompt-diff.md` | 原 Prompt、公开集最佳版本和最终发布版本的差异 |
| `badcases.jsonl` | 失败、改善、回归与关键失败样本 |
| `run-log.jsonl` | 脱敏后的配置、测试快照、评测结果与机器证据 |

需要排查问题时才使用 `--output debug`；它会额外保留原始响应、自动出题审计和候选诊断文件。

## 如何判断结果能不能用

不要只看总分。准备部署 `best-prompt.md` 前，应同时确认：

1. 公开集相对基线确有提升。
2. Holdout 没有严重退步或触发回滚。
3. `prompt-diff.md` 没有虚构后台权限、无关权威、过度拒绝或偏离业务目标的新规则。
4. `badcases.jsonl` 中没有未处理的关键安全类失败。

`accepted` 可进入人工业务验收；`needs_review` 必须先复核；`rejected` 或 Holdout 回滚时保留原 Prompt。

## 测试与本地安装包

```powershell
npm run build
npm test
npm pack
```

`npm pack` 生成可本地交付的 `.tgz` 安装包。包内仅包含 CLI、示例、README 与环境变量模板；不会包含 `.env`、运行记录、历史验收材料或调试文件。npm Registry 发布不是当前使用项目的前提。

## 私有 GitHub 发布

推荐将源码放在私有 GitHub 仓库：GitHub 用于保存代码、README、CI 与版本历史；`npm pack` 用于需要时交付安装包。提交前必须确认 `.env`、`runs/`、历史 V1-V6 材料和 API Key 都不在 Git 暂存区。

## 安全边界

- 不在配置、命令行、报告或 Git 提交中写 API Key。
- `run-log.jsonl` 会脱敏敏感配置字段。
- 未知 Provider 类型必须失败，不能自动换成 mock。
- 同模型生成与评分可能有偏差；正式业务应增加独立人工抽检或不同模型复核。

## CI

GitHub Actions 会在 push 与 pull request 时执行构建和离线测试。CI 不读取真实 `.env`，不注入 API Key，也不调用真实模型。
