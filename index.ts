import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * agents-md-tracker — 自动维护 AGENTS.md 项目状态跟踪
 *
 * - session_start：当前目录没有 AGENTS.md 时自动创建骨架（含精简约束和
 *   subagent 规则）；已有则检查大小，超过阈值（默认 24KB / ~8k tokens）提醒精简
 * - before_agent_start：若 AGENTS.md 缺少维护规则标记（如手写的文件），向系统
 *   提示注入维护规则，保证跨会话持续跟踪项目状态
 * - /init 命令保留：手动触发调研并创建/增量更新 AGENTS.md
 *
 * 文件中含 MARKER 注释即视为"已带维护规则"（自动创建和 /init 都会写入），
 * 此时不再注入，避免与上下文文件内容重复。
 */

const MARKER = "<!-- agents-md-tracker -->";
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
/** 超过此大小（字节）提醒用户精简 AGENTS.md */
const SIZE_WARN_BYTES = 24 * 1024;
/** 超过此大小（估算 token）提醒用户精简 AGENTS.md */
const SIZE_WARN_TOKENS = 8 * 1024;
/** 粗略估算：1 token ≈ 3 字节（中英混合偏保守） */
const BYTES_PER_TOKEN = 3;

/** 供自动创建用的最小 AGENTS.md 骨架（自带维护规则，无需再注入） */
const SKELETON = `# AGENTS.md

<!-- agents-md-tracker -->

## 维护规则（给 AI agent）

- AGENTS.md 是给未来会话的快速上手指南，不是日志：保持精简，预计超过 ~150 行时优先删旧信息、合并重复内容，而不是继续追加。
- 只记录跨会话有复用价值的信息（约定、命令、当前状态）；细节放代码注释或独立文档，在 AGENTS.md 里给路径即可。
- 不要记流水账：不逐条罗列会话过程、临时改动、中间状态；只保留当前有效的结论。
- 完成重要改动（新功能、架构调整、关键决策、发现重要的坑）后，同步更新「当前进展与状态」。
- 发现过时内容（命令失效、结构变化）时顺手修正。
- 遇到适合 subagent 的大型任务，按下方 subagent 规则执行。

## Subagent 规则

主会话的上下文是稀缺资源，其精炼优先于任务完成速度。凡预计消耗大量上下文的子任务（大规模搜索、批量文件阅读、冗长生成等），倾向派 subagent 隔离执行，主会话只保留结论。

## 项目概述

（待补充）

## 技术栈与结构

（待补充）

## 常用命令

（待补充）

## 当前进展与状态

（待补充）
`;

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

- AGENTS.md 是给未来会话的快速上手指南，不是日志：保持精简，预计超过 ~150 行时优先删旧信息、合并重复内容，而不是继续追加。
- 只记录跨会话有复用价值的信息（约定、命令、当前状态）；细节放代码注释或独立文档，在 AGENTS.md 里给路径即可。
- 不要记流水账：不逐条罗列会话过程、临时改动、中间状态；只保留当前有效的结论。
- 完成重要改动（新功能、架构调整、关键决策、发现重要的坑）后，同步更新「当前进展与状态」。
- 发现本文件中过时的内容（命令失效、结构变化）时顺手修正。
- 遇到适合 subagent 的大型任务，按下方 subagent 规则执行。

## Subagent 规则

主会话的上下文是稀缺资源，其精炼优先于任务完成速度。凡预计消耗大量上下文的子任务（大规模搜索、批量文件阅读、冗长生成等），倾向派 subagent 隔离执行，主会话只保留结论。

4. **如果 AGENTS.md 已存在**：做增量更新而非重写——修正过时信息、补充新发现、更新进展部分，并说明改了什么。若文件明显偏大（约 150 行以上），主动精简：删除过时段落、合并重复内容，并在汇报里说明瘦身结果。

完成后简要汇报：项目是什么、AGENTS.md 里写了哪些要点。`;
}

function shouldWarnSize(content: string): boolean {
	if (content.length >= SIZE_WARN_BYTES) return true;
	return Math.ceil(content.length / BYTES_PER_TOKEN) >= SIZE_WARN_TOKENS;
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
		const file = findContextFile(ctx.cwd);
		if (!file) {
			// 自动创建最小骨架，自带维护规则；agent 在首次对话时增量补全各节内容
			try {
				writeFileSync(join(ctx.cwd, "AGENTS.md"), SKELETON, "utf-8");
				if (ctx.hasUI) {
					ctx.ui.notify("agents-md-tracker: 已自动创建 AGENTS.md 骨架（精简约束 + subagent 规则），agent 会在对话时补全项目信息", "info");
				}
			} catch {
				if (ctx.hasUI) ctx.ui.notify("agents-md-tracker: 自动创建 AGENTS.md 失败，可手动运行 /init", "warning");
			}
			return;
		}
		const content = readFileSync(file, "utf-8");
		if (shouldWarnSize(content)) {
			const kb = (statSync(file).size / 1024).toFixed(1);
			const tokens = Math.ceil(content.length / BYTES_PER_TOKEN);
			if (ctx.hasUI) {
				ctx.ui.notify(`agents-md-tracker: AGENTS.md 已达 ${kb}KB（约 ${tokens} tokens），偏大且每次会话都会整份注入上下文，建议让 agent 精简它（删过时内容、细节外移）`, "warning");
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const file = findContextFile(ctx.cwd);
		if (!file || hasMaintenanceRule(file)) return;
		return { systemPrompt: event.systemPrompt + INJECTED_RULE };
	});
}
