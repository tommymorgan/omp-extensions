import { afterEach, beforeAll, expect, test } from "bun:test";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { ConversationHistoryEditor } from "../src/conversation-history-editor";
import { PromptHistoryStore } from "../src/prompt-history-store";

const stores: PromptHistoryStore[] = [];
beforeAll(() => initTheme(false));
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function setup() {
	const store = new PromptHistoryStore(":memory:");
	stores.push(store);
	store.record("current", "abcdefghijklmnopqrstuvwxyz0123456789");
	store.record("other", "foreign conversation");
	const editor = new ConversationHistoryEditor(getEditorTheme());
	editor.configureHistory("current", "session", store);
	return { editor, store };
}

test("scoped recalled prompts retain displayed-row Home/End and reversible insertion", () => {
	const { editor } = setup();
	editor.setBorderVisible(false);
	editor.setPaddingX(0);
	editor.render(12);
	editor.handleInput("\x1b[A");
	for (let index = 0; index < 18; index++) editor.handleInput("\x1b[C");
	editor.render(12);
	editor.handleInput("\x1b[H");
	expect(editor.getCursor()).toEqual({ line: 0, col: 12 });
	editor.handleInput("\x1b[F");
	expect(editor.getCursor()).toEqual({ line: 0, col: 23 });
	editor.handleInput("!");
	expect(editor.getText()).toBe("abcdefghijklmnopqrstuvw!xyz0123456789");
	editor.handleInput("\x1b[122;6u");
	expect(editor.getText()).toBe("abcdefghijklmnopqrstuvwxyz0123456789");
	editor.handleInput("\x1b[121;6u");
	expect(editor.getText()).toBe("abcdefghijklmnopqrstuvw!xyz0123456789");
});

test("scope changes retain undo and redo after a canceled draft", () => {
	const { editor, store } = setup();
	editor.handleInput("canceled draft");
	editor.clearDraftForRecall();
	editor.handleInput("first");
	editor.handleInput("\x1b[H");
	editor.handleInput("prefix ");
	editor.configureHistory("current", "all", store);
	editor.handleInput("\x1b[122;6u");
	expect(editor.getText()).toBe("first");
	editor.configureHistory("current", "session", store);
	editor.handleInput("\x1b[121;6u");
	expect(editor.getText()).toBe("prefix first");
});

test("switching conversations cannot undo back into the previous conversation", () => {
	const { editor, store } = setup();
	editor.handleInput("private");
	editor.handleInput("\x1b[H");
	editor.handleInput("old ");
	// The host can replace composer content through its native edit API.
	editor.applyHostEdit({ from: 0, to: editor.getText().length, text: "new draft", cursor: 9, len: editor.getText().length });
	editor.configureHistory("other", "session", store);
	editor.handleInput("\x1b[122;6u");
	expect(editor.getText()).toBe("new draft");
	editor.clearDraft();
	editor.handleInput("\x1b[A");
	expect(editor.getText()).toBe("foreign conversation");
});
