import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup, register } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { ConversationHistoryEditor } from "./editor";
import { PromptHistoryStore } from "./store";

type HistoryScope = "all" | "session";

export const historyScope =
	lookup("conversationHistory.scope") ??
	register({
		id: "conversationHistory.scope",
		type: "enum",
		values: ["all", "session"] as const,
		default: "all",
	});

/** An independently loadable history implementation for the unmodified host. */
export default async function conversationHistory(pi: ExtensionAPI): Promise<void> {
	const directory = path.join(getAgentDir(), "conversation-history");
	const configFile = path.join(directory, "config.json");
	const configSchema = pi.zod.object({ scope: pi.zod.enum(["all", "session"]) });
	let scope: HistoryScope = "all";
	try {
		scope = configSchema.parse(await Bun.file(configFile).json()).scope;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	historyScope.override(pi.pi.settings, scope);
	await fs.mkdir(directory, { recursive: true });
	const store = new PromptHistoryStore(path.join(directory, "history.db"));
	let context: ExtensionContext | undefined;
	let editor: ConversationHistoryEditor | undefined;
	let installed = false;
	let removeTerminalListener: (() => void) | undefined;

	const createEditor = (...args: ConstructorParameters<typeof ConversationHistoryEditor>) => {
		editor = new ConversationHistoryEditor(...args);
		configureCurrentEditor();
		return editor;
	};

	function ensureEditor(ctx: ExtensionContext): void {
		const factory = ctx.ui.getEditorComponent();
		if (factory === createEditor) return;
		if (factory) {
			ctx.ui.setStatus("conversation-history", "Conversation history inactive: another editor owns input");
			return;
		}
		ctx.ui.setEditorComponent(createEditor);
		ctx.ui.setStatus("conversation-history", undefined);
	}

	function configureCurrentEditor(): void {
		if (!context) return;
		editor?.configureHistory(context.sessionManager.getSessionId(), scope, store);
	}

	function restoreSession(ctx: ExtensionContext): void {
		context = ctx;
		store.restoreSession(ctx.sessionManager.getSessionId(), ctx.sessionManager.getEntries());
		configureCurrentEditor();
	}

	const stopScopeListener = historyScope.listen(pi.pi.settings, async next => {
		if (next !== "all" && next !== "session") throw new Error("Invalid conversation history scope");
		scope = next;
		configureCurrentEditor();
		await Bun.write(configFile, `${JSON.stringify({ scope })}\n`);
	});

	pi.on("session_start", (_event, ctx) => {
		restoreSession(ctx);
		if (!ctx.hasUI || installed) return;
		installed = true;
		ensureEditor(ctx);
		removeTerminalListener = ctx.ui.onTerminalInput(() => {
			ensureEditor(ctx);
			configureCurrentEditor();
			return undefined;
		});
	});
	pi.on("session_switch", (_event, ctx) => restoreSession(ctx));
	pi.on("session_branch", (_event, ctx) => restoreSession(ctx));
	pi.on("session_tree", (_event, ctx) => restoreSession(ctx));
	pi.on("input", (event, ctx) => {
		context = ctx;
		if (event.source !== "extension") {
			store.record(ctx.sessionManager.getSessionId(), event.text);
			pi.appendEntry("tommymorgan.conversation-history.prompt", { text: event.text });
		}
		configureCurrentEditor();
	});
	pi.on("session_shutdown", () => {
		removeTerminalListener?.();
		stopScopeListener();
		store.close();
	});

	pi.registerCommand("history-scope", {
		description: "Choose All sessions or Current conversation for Up/Down prompt recall",
		getArgumentCompletions(prefix) {
			return ["all", "session"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
		},
		async handler(args, ctx) {
			let selected = args.trim();
			if (!selected) {
				const label = await ctx.ui.select("Prompt History Scope", ["All sessions", "Current conversation"], {
					initialIndex: scope === "all" ? 0 : 1,
				});
				if (!label) return;
				selected = label === "All sessions" ? "all" : "session";
			}
			if (selected !== "all" && selected !== "session") {
				ctx.ui.notify("Use /history-scope all or /history-scope session", "error");
				return;
			}
			context = ctx;
			historyScope.override(pi.pi.settings, selected);
			scope = selected;
			configureCurrentEditor();
			await Bun.write(configFile, `${JSON.stringify({ scope })}\n`);
			ctx.ui.notify(`Prompt history: ${scope === "all" ? "All sessions" : "Current conversation"}`, "info");
		},
	});
}
