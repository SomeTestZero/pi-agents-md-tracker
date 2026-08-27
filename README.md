# pi-agents-md-tracker

轻量的 [pi](https://pi.dev) 扩展：用项目根目录的 `AGENTS.md` 做跨会话的项目状态跟踪。

## 功能

- **`/init [补充说明]`**：让 agent 调研项目，创建或增量更新 `AGENTS.md`（项目概述、技术栈与结构、常用命令、约定、**当前进展与状态**），并在文件末尾写入带标记的维护规则。
- **启动提醒**：会话启动时当前目录没有 `AGENTS.md`，提示可用 `/init`。
- **规则自动注入**：若 `AGENTS.md` 存在但不含维护规则标记（如手写的文件），每次对话前自动向系统提示追加一条简短的维护规则，提醒 agent 完成重要改动后更新「当前进展与状态」。

防重复：`/init` 生成的文件含 `<!-- agents-md-tracker -->` 注释标记，扩展检测到标记即不再注入（规则已随 `AGENTS.md` 自动加载进上下文）。

## 安装

```bash
pi install git:github.com/SomeTestZero/pi-agents-md-tracker
```

更新：

```bash
pi update --extensions
```

## 使用

```
/init                        # 首次创建 AGENTS.md
/init 重点关注 mod 加载逻辑    # 带补充说明
```

之后正常工作即可，agent 会按维护规则自行更新进展区块；pi 启动时自动加载 `AGENTS.md`，新会话自动获得最新项目状态。
