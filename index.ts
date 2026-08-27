import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * agents-md-tracker — 轻量 AGENTS.md 项目状态跟踪
 *
 * - /init 命令：让 agent 创建或增量更新当前目录的 AGENTS.md
 * - session_start：当前目录没有 AGENTS.md 时提示可用 /init
 * - before_agent_start：若 AGENTS.md 缺少维护规则标记，向系统提示注入
 *   一条简短的维护规则，保证跨会话持续跟踪项目状态
 *
 * 文件中含 MARKER 注释即视为"已带维护规则"（/init 会写入），此时不再注入，
 * 避免与上下文文件内容重复。
 */

const MARKER = "<!-- agents-md-tracker -->";
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

function findContextFile(cwd: string): string | null {
	for (const name of CONTEXT_FILES) {
		const p = join(cwd, name);
		if (existsSync(p)) return p;
	}
	return null;
}

function hasMaintenanceRule(filePath: string): boolean {
	try {
		return readFileSync(filePath, "utf-8").includes(MARKER);
	} catch {
		return false;
	}
}

const INJECTED_RULE = `

${MARKER}
项目状态跟踪（agents-md-tracker 扩展）：
- 完成重要改动（新功能、架构调整、关键决策、发现重要的坑）后，同步更新 AGENTS.md 的「当前进展与状态」部分，只记录对后续工作有价值的信息。
- 发现 AGENTS.md 内容过时（命令失效、结构变化）时顺手修正；保持简洁，不记流水账。`;

function buildInitPrompt(args: string): string {
	const extra = args.trim();
	return `分析当前项目，创建或更新当前工作目录下的 AGENTS.md，作为跨会话的项目状态跟踪文件。${extra ? `\n额外要求：${extra}` : ""}

步骤：

1. **调研项目**：浏览目录结构、README、构建/配置文件（package.json、Cargo.toml、pyproject.toml、*.csproj、Makefile 等）、现有文档，了解技术栈和项目用途。如果 AGENTS.md 已存在，先读取，保留仍然准确的内容。

2. **创建/更新 AGENTS.md**，包含以下部分：
   - **项目概述**：一两句话说明项目是什么、做什么
   - **技术栈与结构**：主要语言、框架、关键目录及其职责
   - **常用命令**：构建、测试、运行、lint 等（从配置文件中确认真实存在的命令，不要编造）
   - **约定与规范**：代码风格、命名、分支/提交约定（有证据才写，没有就省略此节）
   - **当前进展与状态**：当前进行中的工作、最近完成的重要改动、已知问题/待办。这一节是"活的"，用于跨会话跟踪项目状态

3. **在 AGENTS.md 末尾逐字写入以下维护规则区块**（包括首行的 HTML 注释标记，原样写入不要改动）：

${MARKER}
## 维护规则（给 AI agent）

- 完成重要改动（新功能、架构调整、关键决策、发现重要坑）后，同步更新本文件的「当前进展与状态」部分，保持简洁，只记录对后续工作有价值的信息。
- 发现本文件中过时的内容（命令失效、结构变化）时顺手修正。
- 不要把本文件写成流水账；它是给未来会话的快速上手指南。

4. **如果 AGENTS.md 已存在**：做增量更新而非重写——修正过时信息、补充新发现、更新进展部分，并说明改了什么。

完成后简要汇报：项目是什么、AGENTS.md 里写了哪些要点。`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "创建/更新 AGENTS.md 项目状态跟踪文件（agents-md-tracker）",
		handler: async (args, ctx) => {
			const prompt = buildInitPrompt(args ?? "");
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				// agent 正在运行时，排队等它做完再执行
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!findContextFile(ctx.cwd) && ctx.hasUI) {
			ctx.ui.notify("agents-md-tracker: 当前目录没有 AGENTS.md，输入 /init 创建项目状态跟踪文件", "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const file = findContextFile(ctx.cwd);
		if (!file || hasMaintenanceRule(file)) return;
		return { systemPrompt: event.systemPrompt + INJECTED_RULE };
	});
}
