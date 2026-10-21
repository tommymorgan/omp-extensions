import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { titleTextFromSkillPrompt } from "@oh-my-pi/pi-tui/chat/skill-title-input";

export const RAW_PROMPT_ENTRY_TYPE = "tommymorgan.conversation-history.prompt";

function normalizePrompt(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+\n/g, "\n")
		.trim();
}

function rawPrompt(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== RAW_PROMPT_ENTRY_TYPE) return undefined;
	const data = entry.data;
	return data && typeof data === "object" && "text" in data && typeof data.text === "string" ? data.text : undefined;
}

function recoveredPrompt(entry: SessionEntry): string | undefined {
	if (entry.type === "custom_message") {
		if (!entry.display) return undefined;
		return titleTextFromSkillPrompt({ role: "custom", ...entry });
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "custom") {
		if (message.display === false) return undefined;
		return titleTextFromSkillPrompt(message);
	}
	if (message.role !== "user" || message.synthetic || message.attribution === "agent") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

/** Extension-owned membership; never opens or changes the host's history database. */
export class PromptHistoryStore {
	#db: Database;
	#closed = false;

	constructor(filename: string) {
		if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
		this.#db = new Database(filename, { create: true, strict: true });
		this.#db.exec(`
			PRAGMA busy_timeout = 5000;
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT PRIMARY KEY,
				restored INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS prompts (
				session_id TEXT NOT NULL,
				prompt TEXT NOT NULL,
				recency INTEGER NOT NULL,
				created_at INTEGER NOT NULL DEFAULT 0,
				source INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (session_id, prompt)
			);
			CREATE INDEX IF NOT EXISTS prompts_recent ON prompts(session_id, recency DESC);
		`);
		const columns = this.#db.query<{ name: string }, []>("PRAGMA table_info(prompts)").all();
		if (!columns.some(column => column.name === "created_at")) {
			this.#db.exec("ALTER TABLE prompts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
		}
		if (!columns.some(column => column.name === "source")) {
			this.#db.exec("ALTER TABLE prompts ADD COLUMN source INTEGER NOT NULL DEFAULT 0");
		}
	}

	#insert(sessionId: string, text: string, createdAt: number, source: number): void {
		const prompt = normalizePrompt(text);
		if (!prompt) return;
		this.#db
			.query(`
			INSERT INTO prompts (session_id, prompt, recency, created_at, source)
			VALUES (?1, ?2, (SELECT COALESCE(MAX(recency), 0) + 1 FROM prompts WHERE session_id = ?1), ?3, ?4)
			ON CONFLICT (session_id, prompt) DO UPDATE SET
				recency = excluded.recency, created_at = excluded.created_at, source = excluded.source
			WHERE excluded.created_at >= prompts.created_at
		`)
			.run(sessionId, prompt, createdAt, source);
	}

	/**
	 * Seed once, in journal order. Subsequent submissions own this session's history:
	 * reimporting expanded journal bodies would corrupt recorded slash spellings.
	 * Legacy journals cannot reconstruct template commands or model-mention spelling.
	 */
	restoreSession(sessionId: string, entries: readonly SessionEntry[]): void {
		this.#db.transaction(() => {
			const session = this.#db
				.query<{ restored: number }, [string]>("SELECT restored FROM sessions WHERE session_id = ?")
				.get(sessionId);
			if (session?.restored) return;
			let rawEntriesOwnHistory = false;
			for (const entry of entries) {
				const raw = rawPrompt(entry);
				if (raw !== undefined) rawEntriesOwnHistory = true;
				const prompt = raw ?? (rawEntriesOwnHistory ? undefined : recoveredPrompt(entry));
				if (prompt !== undefined) {
					const timestamp = Date.parse(entry.timestamp);
					this.#insert(sessionId, prompt, Number.isFinite(timestamp) ? timestamp : 0, 1);
				}
			}
			this.#db
				.query(
					"INSERT INTO sessions (session_id, restored) VALUES (?, 1) ON CONFLICT (session_id) DO UPDATE SET restored = 1",
				)
				.run(sessionId);
		})();
	}

	/** Adds trustworthy host rows by submission time without replacing known prompts. */
	seedSession(sessionId: string, entries: readonly { prompt: string; created_at?: number }[]): void {
		this.#db.transaction(() => {
			for (const entry of entries) {
				const prompt = normalizePrompt(entry.prompt);
				if (!prompt) continue;
				this.#db
					.query(`
					INSERT INTO prompts (session_id, prompt, recency, created_at, source)
					VALUES (?1, ?2, (SELECT COALESCE(MIN(recency), 1) - 1 FROM prompts WHERE session_id = ?1), ?3, 0)
					ON CONFLICT (session_id, prompt) DO NOTHING
				`)
					.run(
						sessionId,
						prompt,
						Number.isFinite(entry.created_at) ? Math.trunc((entry.created_at ?? 0) * 1000) : 0,
					);
			}
		})();
	}

	record(sessionId: string, text: string): void {
		if (!normalizePrompt(text)) return;
		this.#db.transaction(() => {
			// A caller that submits before its first restore already owns exact raw text.
			this.#db
				.query("INSERT INTO sessions (session_id, restored) VALUES (?, 1) ON CONFLICT (session_id) DO NOTHING")
				.run(sessionId);
			this.#insert(sessionId, text, Date.now(), 2);
		})();
	}

	recent(sessionId: string, limit = 100): { prompt: string }[] {
		return this.#db
			.query<{ prompt: string }, [string, number]>(
				"SELECT prompt FROM prompts WHERE session_id = ? ORDER BY created_at DESC, source DESC, recency DESC, prompt ASC LIMIT ?",
			)
			.all(sessionId, Math.max(0, Math.trunc(limit)));
	}

	close(): void {
		if (this.#closed) return;
		this.#db.close();
		this.#closed = true;
	}
}
