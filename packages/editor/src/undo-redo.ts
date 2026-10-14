import { CustomEditor } from '@oh-my-pi/pi-coding-agent';
import { extractPrintableText, matchesKey, parseKittySequence } from '@oh-my-pi/pi-tui';

interface Cursor {
  line: number;
  col: number;
}

interface Snapshot {
  text: string;
  cursor: Cursor;
}

type EditKind = 'typing' | 'delete-backward' | 'delete-forward';

interface EditGroup {
  kind: EditKind;
  lastEditedAt: number;
  cursorAfter: Cursor;
}

const CTRL_SHIFT_MODIFIER = 5;
const NON_LOCK_MODIFIER_MASK = 63;
const EDIT_GROUP_DELAY_MS = 500;
const MAX_HISTORY_DEPTH = 100;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isSingleGrapheme(text: string): boolean {
  const segments = GRAPHEME_SEGMENTER.segment(text)[Symbol.iterator]();
  const first = segments.next();
  return !first.done && segments.next().done === true;
}

function matchesCtrlShiftKey(data: string, key: 'y' | 'z'): boolean {
  const parsed = parseKittySequence(data);
  if (parsed) {
    const codepoint = key.codePointAt(0);
    return (
      (parsed.codepoint === codepoint || parsed.baseLayoutKey === codepoint) &&
      (parsed.modifier & NON_LOCK_MODIFIER_MASK) === CTRL_SHIFT_MODIFIER
    );
  }
  return matchesKey(data, `ctrl+shift+${key}`);
}

export class UndoRedoEditor extends CustomEditor {
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  private activeGroup: EditGroup | undefined;

  override handleInput(data: string): void {
    if (matchesCtrlShiftKey(data, 'z')) {
      this.undo();
      return;
    }
    if (matchesCtrlShiftKey(data, 'y')) {
      this.redo();
      return;
    }

    const before = this.snapshot();
    super.handleInput(data);
    const after = this.snapshot();

    if (before.text === after.text) {
      this.activeGroup = undefined;
      return;
    }

    const now = Date.now();
    const kind = this.editKind(data, before, after);
    const joinsActiveGroup =
      kind !== undefined &&
      this.activeGroup?.kind === kind &&
      now - this.activeGroup.lastEditedAt <= EDIT_GROUP_DELAY_MS &&
      this.sameCursor(before.cursor, this.activeGroup.cursorAfter);

    if (!joinsActiveGroup) this.pushHistory(this.undoStack, before);
    this.redoStack.length = 0;
    this.activeGroup = kind ? { kind, lastEditedAt: now, cursorAfter: after.cursor } : undefined;
  }

  protected breakEditGroup(): void {
    this.activeGroup = undefined;
  }

  override setText(text: string): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.activeGroup = undefined;
    super.setText(text);
  }


  private snapshot(): Snapshot {
    const visibleText = this.getText();
    const expandedText = this.getExpandedText();
    return {
      text: expandedText,
      // Collapsed paste markers do not expose enough public state to map their
      // cursor into expanded text. Restoring at the end keeps submitted content
      // correct instead of restoring a dead marker.
      cursor: visibleText === expandedText ? this.getCursor() : this.endCursor(expandedText),
    };
  }

  private undo(): void {
    const snapshot = this.undoStack.pop();
    this.activeGroup = undefined;
    if (!snapshot) return;

    this.pushHistory(this.redoStack, this.snapshot());
    this.restore(snapshot);
  }

  private redo(): void {
    const snapshot = this.redoStack.pop();
    this.activeGroup = undefined;
    if (!snapshot) return;

    this.pushHistory(this.undoStack, this.snapshot());
    this.restore(snapshot);
  }

  private restore(snapshot: Snapshot): void {
    super.setText(snapshot.text);
    this.restoreCursor(snapshot.cursor);
  }

  private editKind(data: string, before: Snapshot, after: Snapshot): EditKind | undefined {
    const printableText = extractPrintableText(data);
    if (
      printableText !== undefined &&
      isSingleGrapheme(printableText) &&
      !printableText.includes('\n') &&
      this.isExactInsertion(before, after, printableText)
    ) {
      return 'typing';
    }
    if (matchesKey(data, 'backspace') || matchesKey(data, 'shift+backspace')) {
      return 'delete-backward';
    }
    if (matchesKey(data, 'delete') || matchesKey(data, 'shift+delete')) {
      return 'delete-forward';
    }
    return undefined;
  }

  private isExactInsertion(before: Snapshot, after: Snapshot, insertedText: string): boolean {
    const beforeOffset = this.snapshotCursorOffset(before);
    const expectedText =
      before.text.slice(0, beforeOffset) + insertedText + before.text.slice(beforeOffset);
    return (
      after.text === expectedText &&
      this.snapshotCursorOffset(after) === beforeOffset + insertedText.length
    );
  }

  private snapshotCursorOffset(snapshot: Snapshot): number {
    const lines = snapshot.text.split('\n');
    let offset = 0;
    for (let line = 0; line < snapshot.cursor.line; line++) {
      offset += (lines[line]?.length ?? 0) + 1;
    }
    return offset + snapshot.cursor.col;
  }

  private sameCursor(left: Cursor, right: Cursor): boolean {
    return left.line === right.line && left.col === right.col;
  }

  private pushHistory(stack: Snapshot[], snapshot: Snapshot): void {
    stack.push(snapshot);
    if (stack.length > MAX_HISTORY_DEPTH) stack.shift();
  }

  private restoreCursor(target: Cursor): void {
    const lines = this.getLines();
    let moves = 0;
    const segmenter = GRAPHEME_SEGMENTER;

    for (let line = target.line; line < lines.length; line++) {
      const text = lines[line] ?? '';
      const suffix = line === target.line ? text.slice(target.col) : text;
      moves += [...segmenter.segment(suffix)].length;
      if (line < lines.length - 1) moves++;
    }

    for (let index = 0; index < moves; index++) super.handleInput('\x1b[D');
  }

  private endCursor(text: string): Cursor {
    const lines = text.split('\n');
    return { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 };
  }
}
