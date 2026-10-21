import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { ConversationHistoryEditor } from "../src/conversation-history-editor";
import { PromptHistoryStore } from "../src/prompt-history-store";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
let directory: string;
let store: PromptHistoryStore;

beforeAll(async () => {
	await initTheme(false);
});
beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-history-editor-"));
	store = new PromptHistoryStore(path.join(directory, "history.db"));
});
afterEach(() => {
	store.close();
	fs.rmSync(directory, { recursive: true, force: true });
});

function setup() {
	const written: string[] = [];
	const editor = new ConversationHistoryEditor(getEditorTheme());
	editor.setHistoryStorage({
		add: async prompt => {
			written.unshift(prompt);
		},
		getRecent: limit => [...written, "other conversation"].slice(0, limit).map(prompt => ({ prompt })),
	});
	editor.configureHistory("first", "all", store);
	return { editor, written };
}

function submit(editor: ConversationHistoryEditor, text: string): void {
	editor.onSubmit = value => editor.clearDraft(value);
	editor.handleInput(text);
	editor.handleInput("\r");
}

describe("ConversationHistoryEditor", () => {
	it("defaults to real global navigation, then limits native recall to current ownership", () => {
		const { editor, written } = setup();
		editor.handleInput(UP);
		expect(editor.getText()).toBe("other conversation");
		editor.clearDraft();
		submit(editor, "first prompt");
		editor.configureHistory("first", "session", store);
		editor.handleInput(UP);
		expect(editor.getText()).toBe("first prompt");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("first prompt");
		expect(written).toEqual(["first prompt"]);
		expect(store.recent("first")).toEqual([{ prompt: "first prompt" }]);
	});

	it("records duplicate submissions under both owners without copying old local drafts", () => {
		const { editor, written } = setup();
		submit(editor, "shared prompt");
		editor.handleInput("private first-owner draft");
		editor.clearDraftForRecall();
		editor.configureHistory("second", "session", store);
		editor.handleInput(UP);
		expect(editor.getText()).toBe("");
		submit(editor, "shared prompt");
		expect(store.recent("first")).toEqual([{ prompt: "shared prompt" }]);
		expect(store.recent("second")).toEqual([{ prompt: "shared prompt" }]);
		expect(written).toEqual(["shared prompt", "shared prompt"]);
	});

	it("retains current composer, caret, expansion, and host listeners across rebinds", () => {
		const { editor, written } = setup();
		const payload = "a large line\n".repeat(20);
		editor.insertPaste(payload);
		editor.handleInput("tail");
		editor.handleInput("\x1b[D");
		const text = editor.getText();
		const expanded = editor.getExpandedText();
		const cursor = editor.getCursor();
		const changes: string[] = [];
		editor.onChange = value => changes.push(value);
		editor.configureHistory("first", "session", store);
		expect(editor.getText()).toBe(text);
		expect(editor.getExpandedText()).toBe(expanded);
		expect(editor.getCursor()).toEqual(cursor);
		expect(changes).toEqual([]);
		expect(written).toEqual([]);
		expect(store.recent("first")).toEqual([]);
		editor.configureHistory("first", "session", store);
		expect(editor.getCursor()).toEqual(cursor);
		editor.handleInput("!");
		expect(changes).toHaveLength(1);
	});

	it("recalls canceled paste and attachment drafts after repeated scope switches without persistence", () => {
		const { editor, written } = setup();
		const paste = "first payload\n".repeat(12);
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		editor.insertTextAttachment("attached text payload");
		const text = editor.getText();
		const expanded = editor.getExpandedText();
		editor.clearDraftForRecall();
		editor.configureHistory("first", "session", store);
		editor.configureHistory("first", "all", store);
		editor.configureHistory("first", "session", store);
		editor.handleInput(UP);
		expect(editor.getText()).toBe(text);
		expect(editor.getExpandedText()).toBe(expanded);
		expect(editor.pendingTexts.map(value => value.content)).toEqual(["attached text payload"]);
		editor.insertPaste("second payload");
		expect(editor.getExpandedText()).toBe(expanded + "second payload");
		expect(written).toEqual([]);
		expect(store.recent("first")).toEqual([]);
	});

	it("restores multiple pastes without recursively expanding token-looking payload text", () => {
		const { editor, written } = setup();
		editor.insertPaste("literal [Paste #2] belongs to the first payload");
		editor.insertPaste("the second payload");
		const text = editor.getText();
		const expanded = editor.getExpandedText();
		editor.clearDraftForRecall();
		submit(editor, "between drafts");
		editor.handleInput("later canceled draft");
		editor.clearDraftForRecall();
		editor.configureHistory("first", "session", store);
		editor.handleInput(UP);
		expect(editor.getText()).toBe("later canceled draft");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("between drafts");
		editor.handleInput(UP);
		expect(editor.getText()).toBe(text);
		expect(editor.getExpandedText()).toBe(expanded);
		expect(written).toEqual(["between drafts"]);
	});

	it("preserves custom restore callbacks before onChange sees recalled text", () => {
		const { editor } = setup();
		let restored = false;
		editor.handleInput("canceled draft");
		editor.rememberDraft(() => {
			restored = true;
		});
		editor.clearDraft();
		editor.configureHistory("first", "session", store);
		const changes: boolean[] = [];
		editor.onChange = () => {
			changes.push(restored);
		};
		editor.handleInput(UP);
		expect(editor.getText()).toBe("canceled draft");
		expect(changes).toEqual([true]);
	});

	it("keeps session scope when the host attaches or replaces its global backend later", () => {
		const editor = new ConversationHistoryEditor(getEditorTheme());
		store.record("first", "owned prompt");
		editor.configureHistory("first", "session", store);
		const written: string[] = [];
		editor.setHistoryStorage({
			add: async prompt => {
				written.push(prompt);
			},
			getRecent: () => [{ prompt: "foreign prompt" }],
		});
		editor.handleInput(UP);
		expect(editor.getText()).toBe("owned prompt");
		editor.clearDraft();
		submit(editor, "new prompt");
		expect(written).toEqual(["new prompt"]);
	});

	it("delegates multiline and wrapped-row movement instead of replacing arrow dispatch", () => {
		const { editor } = setup();
		editor.configureHistory("first", "session", store);
		submit(editor, "owned prompt");
		editor.handleInput("\x1b[200~first line\nsecond line\x1b[201~");
		editor.render(24);
		editor.handleInput(UP);
		expect(editor.getText()).toBe("first line\nsecond line");
		expect(editor.getCursor().line).toBe(0);
		editor.handleInput(DOWN);
		expect(editor.getText()).toBe("first line\nsecond line");
		expect(editor.getCursor().line).toBe(1);
		editor.clearDraft();
		editor.handleInput("a long line that wraps across several displayed rows");
		editor.render(24);
		const before = editor.getCursor();
		editor.handleInput(UP);
		expect(editor.getText()).toBe("a long line that wraps across several displayed rows");
		expect(editor.getCursor().col).toBeLessThan(before.col);
	});
});
