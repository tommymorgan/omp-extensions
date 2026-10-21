import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import type { PromptHistoryStore } from "./store";

type HistoryBackend = Parameters<CustomEditor["setHistoryStorage"]>[0];
type DraftSnapshot = {
	text: string;
	pastes: Map<number, string>;
	atoms: Map<string, string>;
	restore?: () => void;
};
type LocalEntry = { prompt: string } | { draft: DraftSnapshot };

/** Uses the native editor's navigation, keybindings, and draft restoration machinery. */
export class ConversationHistoryEditor extends CustomEditor {
	#globalStorage?: HistoryBackend;
	#store?: PromptHistoryStore;
	#sessionId?: string;
	#scope: "all" | "session" = "all";
	#local: LocalEntry[] = [];
	#atoms = new Map<string, string>();
	#rebuilding = false;
	#backend: HistoryBackend = {
		add: (prompt, cwd) =>
			this.#rebuilding ? Promise.resolve() : (this.#globalStorage?.add(prompt, cwd) ?? Promise.resolve()),
		getRecent: limit => {
			const recent =
				this.#scope === "session" && this.#store && this.#sessionId
					? this.#store.recent(this.#sessionId, limit)
					: (this.#globalStorage?.getRecent(limit) ?? []);
			const localPrompts = new Set(this.#local.flatMap(entry => ("prompt" in entry ? [entry.prompt] : [])));
			return recent.filter(entry => !localPrompts.has(entry.prompt));
		},
	};

	configureHistory(sessionId: string, scope: "all" | "session", store: PromptHistoryStore): void {
		if (this.#sessionId === sessionId && this.#scope === scope && this.#store === store) return;
		if (this.#sessionId !== sessionId) this.#local = [];
		this.#sessionId = sessionId;
		this.#scope = scope;
		this.#store = store;
		this.#rebind();
	}

	override setHistoryStorage(storage: HistoryBackend): void {
		this.#globalStorage = storage;
		this.#rebind();
	}

	override addToHistory(text: string): void {
		const prompt = text.trim();
		if (!prompt) return;
		super.addToHistory(text);
		if (this.#sessionId) this.#store?.record(this.#sessionId, prompt);
		const previous = this.#local.at(-1);
		if (previous && "prompt" in previous && previous.prompt === prompt) return;
		this.#local.push({ prompt });
		if (this.#local.length > 100) this.#local.shift();
	}

	override rememberDraft(restore?: () => void): void {
		if (!this.getText().trim()) return;
		const draft = this.#capture(restore);
		this.#local.push({ draft });
		if (this.#local.length > 100) this.#local.shift();
		super.rememberDraft(this.#draftRestore(draft));
	}

	override registerAtom(label: string, expansion: string): void {
		this.#atoms.set(label, expansion);
		super.registerAtom(label, expansion);
	}

	override clearAtoms(): void {
		this.#atoms.clear();
		super.clearAtoms();
	}

	override clearPasteState(): void {
		this.#atoms.clear();
		super.clearPasteState();
	}

	override restoreHistoryState(restore?: () => void): void {
		this.#atoms.clear();
		super.restoreHistoryState(restore);
	}

	#draftRestore(draft: DraftSnapshot): () => void {
		return () => {
			this.#atoms = new Map(draft.atoms);
			draft.restore?.();
		};
	}

	#capture(restore?: () => void): DraftSnapshot {
		const text = this.getText();
		const pastes = new Map<number, string>();
		const atoms = new Map([...this.#atoms].filter(([label]) => text.includes(label)));
		const markers = [...text.matchAll(/\[Paste #(\d+)(?:, (?:\+\d+ lines|\d+ chars))?\]/g)];
		if (markers.length) {
			// The public expansion API expands the entire buffer, not an arbitrary label.
			// Probe labels silently; no temporary text reaches the host's composer listener.
			this.#silently(() => {
				for (const match of markers) {
					super.setText(match[0]);
					const expanded = this.getExpandedText();
					if (expanded !== match[0]) pastes.set(Number(match[1]), expanded);
				}
				super.setText(text);
			});
		}
		return { text, pastes, atoms, restore };
	}

	#silently(action: () => void): void {
		const onChange = this.onChange;
		const cursor = this.getCursor();
		const lines = this.getText().split("\n");
		const offset = lines.slice(0, cursor.line).reduce((sum, line) => sum + line.length + 1, 0) + cursor.col;
		this.onChange = undefined;
		try {
			action();
			this.applyHostEdit({ from: 0, to: 0, text: "", cursor: offset, len: this.getText().length });
		} finally {
			this.onChange = onChange;
		}
	}

	#load(draft: DraftSnapshot): void {
		super.clearPasteState();
		// Recreate native paste IDs, including holes left by deleted markers. Using atoms
		// for paste labels would collide with the next native paste's monotonic ID.
		const maxId = Math.max(0, ...draft.pastes.keys());
		for (let id = 1; id <= maxId; id++) super.insertPaste(draft.pastes.get(id) ?? "");
		for (const [label, expansion] of draft.atoms) super.registerAtom(label, expansion);
		this.#atoms = new Map(draft.atoms);
		super.setText(draft.text);
	}

	#rebind(): void {
		if (this.#globalStorage instanceof HistoryStorage && this.#sessionId && this.#store) {
			this.#store.seedSession(this.#sessionId, this.#globalStorage.getRecent(100, { sessionId: this.#sessionId }));
		}
		const current = this.#local.some(entry => "draft" in entry) ? this.#capture() : undefined;
		this.#silently(() => {
			this.#rebuilding = true;
			try {
				super.setHistoryStorage(this.#backend);
				for (const entry of this.#local) {
					if ("prompt" in entry) super.addToHistory(entry.prompt);
					else {
						this.#load(entry.draft);
						super.rememberDraft(this.#draftRestore(entry.draft));
					}
				}
				if (current) this.#load(current);
			} finally {
				this.#rebuilding = false;
			}
		});
	}
}
