import { matchesKey } from '@oh-my-pi/pi-tui';
import { UndoRedoEditor } from './undo-redo.ts';

const DOWN_ARROW = '\x1b[B';
const RIGHT_ARROW = '\x1b[C';
const UP_ARROW = '\x1b[A';
const MAX_KEY_PRESSES = 128;
const MAX_NAVIGATION_MS = 80;

interface NavigationBudget {
  remaining: number;
  deadline: number;
}

export class HomeEndEditor extends UndoRedoEditor {
  override handleInput(data: string): void {
    if (this.vimMode !== 'insert') {
      super.handleInput(data);
      return;
    }

    // Modified Home/End address the complete draft, not its displayed rows.
    if (matchesKey(data, 'ctrl+home')) {
      this.breakEditGroup();
      this.moveToMessageStart();
      return;
    }
    if (matchesKey(data, 'ctrl+end')) {
      this.breakEditGroup();
      this.moveToMessageEnd();
      return;
    }

    if (matchesKey(data, 'home') || matchesKey(data, 'end')) {
      this.breakEditGroup();
      const budget = {
        remaining: MAX_KEY_PRESSES,
        deadline: performance.now() + MAX_NAVIGATION_MS,
      };
      this.moveWithinDisplayedRow(matchesKey(data, 'end'), budget);
      return;
    }

    super.handleInput(data);
  }

  /** Never synthesize more than the shared per-key budget; one reserved cleanup press may cross the deadline. */
  private press(key: string, budget: NavigationBudget, cleanup = false): boolean {
    if (budget.remaining === 0 || (!cleanup && performance.now() >= budget.deadline)) return false;
    budget.remaining--;
    super.handleInput(key);
    return true;
  }

  private displayedRowBoundaries(budget: NavigationBudget): { start: number; nextStart?: number } | undefined {
    const original = this.getCursor();
    const lineLength = this.getText().split('\n')[original.line]?.length ?? 0;
    const starts = [0];
    this.moveToLineStart();

    // Down uses the base editor's visual-row map. It may retain a preferred column,
    // so stop if it stops advancing rather than assuming it found another row.
    while (budget.remaining > 1 && performance.now() < budget.deadline) {
      const before = this.getCursor();
      if (!this.press(DOWN_ARROW, budget)) return undefined;
      const after = this.getCursor();
      if (after.line !== original.line) {
        this.press(UP_ARROW, budget, true);
        break;
      }
      if (after.col <= before.col) break;
      // Down on the final displayed row jumps after the last character.
      // That insertion position is not the start of another displayed row.
      if (after.col === lineLength) break;
      starts.push(after.col);
    }

    // An incomplete scan cannot identify the row that contained the original cursor.
    if (budget.remaining <= 1 || performance.now() >= budget.deadline) return undefined;
    let row = 0;
    while (row + 1 < starts.length && (starts[row + 1] ?? 0) <= original.col) row++;
    return { start: starts[row] ?? 0, nextStart: starts[row + 1] };
  }

  private moveWithinDisplayedRow(toEnd: boolean, budget: NavigationBudget): void {
    const line = this.getCursor().line;
    const bounds = this.displayedRowBoundaries(budget);
    if (!bounds) {
      if (toEnd) this.moveToLineEnd();
      else this.moveToLineStart();
      return;
    }

    this.moveToLineStart();
    while (this.getCursor().col < bounds.start) {
      const before = this.getCursor();
      if (!this.press(DOWN_ARROW, budget)) return;
      const after = this.getCursor();
      if (after.line !== line || after.col <= before.col) return;
    }
    if (!toEnd) return;
    if (bounds.nextStart === undefined) {
      this.moveToLineEnd();
      return;
    }

    while (this.getCursor().col < bounds.nextStart - 1) {
      const before = this.getCursor();
      if (!this.press(RIGHT_ARROW, budget)) return;
      const after = this.getCursor();
      if (after.line !== line || after.col <= before.col) return;
    }
  }
}
