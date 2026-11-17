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
/** 粗略估算：1 token ≈ 3 字节（中英混合偏保守；实际随 tokenizer 与中英文比例浮动） */
const BYTES_PER_TOKEN = 3;

/** 供自动创建用的最小 AGENTS.md 骨架（自带维护规则，无需再注入） */
const SKELETON = `# AGENTS.md

<!-- agents-md-tracker -->

## 维护规则（给 AI agent）

- AGENTS.md 是给未来会话的快速上手指南，不是日志：只记录当前有效的结论和跨会话有复用价值的信息（约定、命令、当前状态），不写会话过程、临时改动、中间状态。
- 保持精简：预计超过 ~24KB（约 8k tokens）时优先删旧信息、合并重复内容，而不是继续追加；细节放代码注释或独立文档，在 AGENTS.md 里给路径即可。
- 完成重要改动（新功能、架构调整、关键决策、发现重要的坑）后，同步更新「当前进展与状态」；发现过时内容（命令失效、结构变化）顺手修正。
- 大范围搜索（全库 grep/find、逐目录翻找、批量读文件）前先评估必要性与收益，能精确匹配、缩小范围就别硬扫。
- 重活 bash 必须带 timeout（按预计耗时留足余量），防止长时间阻塞会话。

## Subagent 规则

主会话的上下文是稀缺资源，精炼优先于任务完成速度：凡预计消耗大量上下文的子任务，倾向派 subagent 隔离执行，主会话只保留结论。大规模搜索、批量文件阅读、冗长生成等只是常见例子，并非穷举——是否派发由 agent 按任务特点（上下文膨胀风险、结果可压缩性等）自行评估。

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

function readContextFile(file: string): string | null {
	try {
		return readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

const INJECTED_RULE = `

${MARKER}
项目状态跟踪（agents-md-tracker 扩展）：
- 完成重要改动（新功能、架构调整、关键决策、发现重要的坑）后，同步更新 AGENTS.md 的「当前进展与状态」部分，只记录对后续工作有价值的信息。
- 发现 AGENTS.md 内容过时（命令失效、结构变化）时顺手修正；保持简洁，不记流水账。
- 不要做大范围的暴力搜索，大范围搜索前先评估必要性；重活 bash 必须带 timeout。`;

/** 规则版本标记：文件含它则视为已带 v0.2.2 新规则（搜索纪律 + bash timeout），无需增补注入 */
const RULE_V2_MARKER = "重活 bash 必须带 timeout";
/** 规则版本标记：文件含它则视为已带 v0.2.3 新阈值（~24KB），无需增补注入 */
const RULE_V3_MARKER = "~24KB";

/** 老 AGENTS.md（有维护规则但缺新规则）的一次性增补提示；agent 把规则补写进文件后自动停止 */
const SUPPLEMENT_RULE = `

${MARKER}
规则增补（老文件升级）：把下面两条规则补写进 AGENTS.md 的「维护规则」区块（逐字写入，补完后本提示自动消失）：
- 大范围搜索（全库 grep/find、逐目录翻找、批量读文件）前先评估必要性与收益，能精确匹配、缩小范围就别硬扫。
- 重活 bash 必须带 timeout（按预计耗时留足余量），防止长时间阻塞会话。`;

/** 老 AGENTS.md（已带 v0.2.2 规则但精简阈值仍按行数）的一次性增补提示；agent 改成 24KB 后自动停止 */
const SUPPLEMENT_V3_RULE = `

${MARKER}
规则增补（老文件升级）：把「维护规则」区块中按行数控制精简的条目（含"~150 行"）替换为下面这条（逐字写入；若没有行数条目则直接补写，补完后本提示自动消失）：
- 保持精简：预计超过 ~24KB（约 8k tokens）时优先删旧信息、合并重复内容，而不是继续追加。`;

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

- AGENTS.md 是给未来会话的快速上手指南，不是日志：只记录当前有效的结论和跨会话有复用价值的信息（约定、命令、当前状态），不写会话过程、临时改动、中间状态。
- 保持精简：预计超过 ~24KB（约 8k tokens）时优先删旧信息、合并重复内容，而不是继续追加；细节放代码注释或独立文档，在 AGENTS.md 里给路径即可。
- 完成重要改动（新功能、架构调整、关键决策、发现重要的坑）后，同步更新「当前进展与状态」；发现过时内容（命令失效、结构变化）顺手修正。
- 大范围搜索（全库 grep/find、逐目录翻找、批量读文件）前先评估必要性与收益，能精确匹配、缩小范围就别硬扫。
- 重活 bash 必须带 timeout（按预计耗时留足余量），防止长时间阻塞会话。

## Subagent 规则

主会话的上下文是稀缺资源，精炼优先于任务完成速度：凡预计消耗大量上下文的子任务，倾向派 subagent 隔离执行，主会话只保留结论。大规模搜索、批量文件阅读、冗长生成等只是常见例子，并非穷举——是否派发由 agent 按任务特点（上下文膨胀风险、结果可压缩性等）自行评估。

4. **如果 AGENTS.md 已存在**：做增量更新而非重写——修正过时信息、补充新发现、更新进展部分，并说明改了什么。若文件明显偏大（约 24KB 以上），主动精简：删除过时段落、合并重复内容，并在汇报里说明瘦身结果。

完成后简要汇报：项目是什么、AGENTS.md 里写了哪些要点。`;
}

function shouldWarnSize(content: string): boolean {
	// 必须按 UTF-8 字节数算：content.length 是字符数，中文 1 字 = 3 字节，
	// 用字符数会把中文文件的实际阈值放宽到约 3 倍（24K 字符 ≈ 72KB）
	const bytes = Buffer.byteLength(content, "utf-8");
	if (bytes >= SIZE_WARN_BYTES) return true;
	return Math.ceil(bytes / BYTES_PER_TOKEN) >= SIZE_WARN_TOKENS;
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
			const tokens = Math.ceil(Buffer.byteLength(content, "utf-8") / BYTES_PER_TOKEN);
			if (ctx.hasUI) {
				ctx.ui.notify(`agents-md-tracker: AGENTS.md 已达 ${kb}KB（约 ${tokens} tokens），偏大且每次会话都会整份注入上下文，建议让 agent 精简它（删过时内容、细节外移）`, "warning");
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const file = findContextFile(ctx.cwd);
		if (!file) return;
		const content = readContextFile(file);
		if (content === null) return;
		// 手写文件：无维护规则标记 → 注入完整维护规则
		if (!content.includes(MARKER)) return { systemPrompt: event.systemPrompt + INJECTED_RULE };
		// 老文件：有维护规则但缺 v0.2.2 新规则，注入增补提示，agent 补写进文件后自动停止
		if (!content.includes(RULE_V2_MARKER)) return { systemPrompt: event.systemPrompt + SUPPLEMENT_RULE };
		// 老文件：已有 v0.2.2 规则但精简阈值仍按行数，提示升级为 ~24KB
		if (!content.includes(RULE_V3_MARKER)) return { systemPrompt: event.systemPrompt + SUPPLEMENT_V3_RULE };
	});
}
