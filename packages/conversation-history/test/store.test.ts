import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { PromptHistoryStore, RAW_PROMPT_ENTRY_TYPE } from "../src/store";

const stores: PromptHistoryStore[] = [];
const directories: string[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function openStore(filename?: string): PromptHistoryStore {
	if (!filename) {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-history-"));
		directories.push(directory);
		filename = path.join(directory, "nested", "prompts.db");
	}
	const store = new PromptHistoryStore(filename);
	stores.push(store);
	return store;
}

function messageEntry(id: string, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-10-20T12:00:00.000Z", message };
}

function human(id: string, text: string): SessionMessageEntry {
	return messageEntry(id, { role: "user", content: text, attribution: "user", timestamp: 1 });
}

function raw(id: string, text: string): SessionEntry {
	return {
		type: "custom",
		customType: RAW_PROMPT_ENTRY_TYPE,
		data: { text },
		id,
		parentId: null,
		timestamp: "2026-10-20T12:00:00.000Z",
	};
}

describe("PromptHistoryStore", () => {
	test("persists each submitting session's membership and recency after reopen", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-history-reopen-"));
		directories.push(directory);
		const filename = path.join(directory, "history.db");
		const first = openStore(filename);
		first.record("one", "shared");
		first.record("one", "newer");
		first.record("two", "shared");
		first.record("two", "other");
		first.close();
		const reopened = openStore(filename);
		reopened.restoreSession("one", [human("untrusted-expansion", "expanded body")]);
		expect(reopened.recent("one")).toEqual([{ prompt: "newer" }, { prompt: "shared" }]);
		expect(reopened.recent("two")).toEqual([{ prompt: "other" }, { prompt: "shared" }]);
		expect(reopened.recent("unrelated")).toEqual([]);
		reopened.record("one", "shared");
		expect(reopened.recent("one", 1)).toEqual([{ prompt: "shared" }]);
		expect(reopened.recent("two")).toEqual([{ prompt: "other" }, { prompt: "shared" }]);
	});

	test("recovers human text and original skill spellings but excludes assistant and injected entries", () => {
		const store = openStore();
		const skill = messageEntry("skill", {
			role: "custom",
			customType: "skill-prompt",
			content: "expanded skill body",
			display: true,
			attribution: "user",
			timestamp: 1,
			details: { name: "review", args: "the diff", __queueChipText: "/skill:review exact original" },
		});
		const entries: SessionEntry[] = [
			human("normal", "normal prompt"),
			messageEntry("legacy", { role: "user", content: "legacy human", timestamp: 1 }),
			messageEntry("parts", {
				role: "user",
				content: [
					{ type: "text", text: "first line" },
					{ type: "text", text: "second line" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: 1,
			}),
			skill,
			{
				type: "custom_message",
				id: "skill-entry",
				parentId: null,
				timestamp: "2026-10-20T12:00:00.000Z",
				customType: "skill-prompt",
				content: "expanded",
				display: true,
				attribution: "user",
				details: { name: "test", args: "focused" },
			},
			messageEntry("synthetic", { role: "user", content: "auto continue", synthetic: true, timestamp: 1 }),
			messageEntry("agent", { role: "user", content: "agent injection", attribution: "agent", timestamp: 1 }),
			messageEntry("assistant", {
				role: "assistant",
				content: [{ type: "text", text: "assistant response" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: 1,
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			messageEntry("autoload", {
				role: "custom",
				customType: "skill-prompt",
				content: "injected skill",
				display: true,
				attribution: "agent",
				timestamp: 1,
				details: { name: "hidden" },
			}),
			messageEntry("notice", {
				role: "custom",
				customType: "notice",
				content: "notice",
				display: false,
				attribution: "user",
				timestamp: 1,
			}),
		];
		store.restoreSession("one", entries);
		expect(store.recent("one")).toEqual([
			{ prompt: "/skill:test focused" },
			{ prompt: "/skill:review exact original" },
			{ prompt: "first line\nsecond line" },
			{ prompt: "legacy human" },
			{ prompt: "normal prompt" },
		]);
	});

	test("uses raw journal markers instead of expanded command bodies after metadata begins", () => {
		const store = openStore();
		store.restoreSession("one", [
			human("old", "older human"),
			raw("command", "/template exact args"),
			human("expanded", "expanded template instructions"),
			raw("local", "/local-command"),
			raw("normal", "normal raw text"),
			human("normal-expanded", "normal transformed text"),
		]);
		expect(store.recent("one")).toEqual([
			{ prompt: "normal raw text" },
			{ prompt: "/local-command" },
			{ prompt: "/template exact args" },
			{ prompt: "older human" },
		]);
	});

	test("repeated restores cannot replace raw submissions or reorder recovered prompts", () => {
		const store = openStore();
		const entries = [human("first", "first"), human("second", "second"), human("repeat", "first")];
		store.restoreSession("one", entries);
		expect(store.recent("one")).toEqual([{ prompt: "first" }, { prompt: "second" }]);
		store.record("one", "/template raw");
		store.restoreSession("one", [...entries, human("expanded", "expanded body")]);
		expect(store.recent("one")).toEqual([{ prompt: "/template raw" }, { prompt: "first" }, { prompt: "second" }]);
		store.restoreSession("fork", entries);
		store.record("fork", "fork only");
		expect(store.recent("fork", 2)).toEqual([{ prompt: "fork only" }, { prompt: "first" }]);
		expect(store.recent("one", 1)).toEqual([{ prompt: "/template raw" }]);
	});

	test("trusted legacy seeds preserve known commands and normalize duplicate terminal copies", () => {
		const store = openStore();
		store.seedSession("one", [{ prompt: "/template args" }, { prompt: "older" }]);
		store.record("one", "  first line  \r\nsecond line\r\n  ");
		store.record("one", "first line\nsecond line");
		store.seedSession("one", [{ prompt: "older" }]);
		expect(store.recent("one")).toEqual([
			{ prompt: "first line\nsecond line" },
			{ prompt: "/template args" },
			{ prompt: "older" },
		]);
		store.record("one", "  \n\t");
		expect(store.recent("one", 0)).toEqual([]);
		expect(store.recent("one")).toHaveLength(3);
	});

	test("merges dated legacy rows with journal chronology without moving known prompts on late seeds", () => {
		const store = openStore();
		store.restoreSession("one", [
			{ ...human("older", "older journal"), timestamp: "2026-10-01T12:00:00.000Z" },
			{ ...human("shared", "shared"), timestamp: "2026-10-02T12:00:00.000Z" },
			{ ...human("latest", "newer journal"), timestamp: "2026-10-15T12:00:00.000Z" },
		]);
		store.seedSession("one", [
			{ prompt: "known legacy", created_at: Date.parse("2026-10-14T12:00:00.000Z") / 1000 },
			{ prompt: "shared", created_at: Date.parse("2026-10-02T12:00:00.000Z") / 1000 },
			{ prompt: "unknown date" },
		]);
		expect(store.recent("one")).toEqual([
			{ prompt: "newer journal" },
			{ prompt: "known legacy" },
			{ prompt: "shared" },
			{ prompt: "older journal" },
			{ prompt: "unknown date" },
		]);
		store.record("one", "/template original");
		store.seedSession("one", [{ prompt: "shared", created_at: Date.parse("2099-01-01T00:00:00.000Z") / 1000 }]);
		expect(store.recent("one")).toEqual([
			{ prompt: "/template original" },
			{ prompt: "newer journal" },
			{ prompt: "known legacy" },
			{ prompt: "shared" },
			{ prompt: "older journal" },
			{ prompt: "unknown date" },
		]);
	});

	test("submissions before the first restore remain authoritative without importing expanded text", () => {
		const store = openStore();
		store.record("one", "/template raw");
		store.restoreSession("one", [human("expanded", "expanded body")]);
		expect(store.recent("one")).toEqual([{ prompt: "/template raw" }]);
	});
});
