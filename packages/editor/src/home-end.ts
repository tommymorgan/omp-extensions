import { type EditorTextDecorationContext, getSegmenter, matchesKey } from '@oh-my-pi/pi-tui';
import { UndoRedoEditor } from './undo-redo.ts';

export class HomeEndEditor extends UndoRedoEditor {
  #preserveCursor = false;
  #renderWidth = 80;

  override render(width: number): readonly string[] {
    this.#renderWidth = width;
    return super.render(width);
  }

  override handleInput(data: string): void {
    const preserveCursor = this.#preserveCursor;
    this.#preserveCursor = false;
    if (this.vimMode !== 'insert') {
      super.handleInput(data);
      return;
    }

    // Modified Home/End address the complete draft, not its displayed rows.
    if (matchesKey(data, 'ctrl+home')) {
      this.breakEditGroup();
      this.moveToMessageStart();
      this.#preserveCursor = true;
      return;
    }
    if (matchesKey(data, 'ctrl+end')) {
      this.breakEditGroup();
      this.moveToMessageEnd();
      this.#preserveCursor = true;
      return;
    }

    if (matchesKey(data, 'home')) {
      this.breakEditGroup();
      this.#moveWithinDisplayedRow(false);
      this.#preserveCursor = true;
      return;
    }
    if (matchesKey(data, 'end')) {
      this.breakEditGroup();
      this.#moveWithinDisplayedRow(true);
      this.#preserveCursor = true;
      return;
    }

    super.handleInput(data, preserveCursor);
  }

  #displayedRow(): EditorTextDecorationContext | undefined {
    const cursor = this.getCursor();
    const decorateText = this.decorateText;
    const focused = this.focused;
    const terminalCursor = this.getUseTerminalCursor();
    let row: EditorTextDecorationContext | undefined;
    try {
      // A non-focused hardware cursor leaves each rendered source span whole:
      // no software glyph or cursor marker splits the decoration callbacks.
      this.focused = false;
      this.setUseTerminalCursor(true);
      this.decorateText = (text, context) => {
        if (context.line === cursor.line &&
            (!row || (context.startCol <= cursor.col && context.startCol >= row.startCol))) {
          row = context;
        }
        return text;
      };
      super.render(this.#renderWidth);
    } finally {
      this.decorateText = decorateText;
      this.focused = focused;
      this.setUseTerminalCursor(terminalCursor);
    }
    return row;
  }

  #moveToColumn(col: number): void {
    const cursor = this.getCursor();
    const lines = this.getLines();
    let offset = col;
    for (let line = 0; line < cursor.line; line++) offset += (lines[line]?.length ?? 0) + 1;
    // A zero-length native edit moves only the caret: no history navigation,
    // text-change callback, paste expansion, or undo entry.
    this.applyHostEdit({ from: 0, to: 0, text: '', cursor: offset, len: this.getText().length });
  }

  #moveWithinDisplayedRow(toEnd: boolean): void {
    const row = this.#displayedRow();
    if (!row) return; // Empty logical lines already have their only caret position.
    this.#moveToColumn(toEnd ? row.endCol : row.startCol);
    if (!toEnd) return;

    // A span's end can be the next row's start. Keep End on the original
    // displayed row, backing up by one whole grapheme only in that case.
    const endRow = this.#displayedRow();
    if (!endRow || endRow.startCol === row.startCol) return;
    const line = this.getLines()[row.line] ?? '';
    let col = row.startCol;
    for (const segment of getSegmenter().segment(line.slice(row.startCol, row.endCol))) {
      col = row.startCol + segment.index;
    }
    this.#moveToColumn(col);
  }
}
