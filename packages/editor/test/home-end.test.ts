import { describe, expect, it } from 'bun:test';
import { getEditorTheme } from '@oh-my-pi/pi-tui';
import { HomeEndEditor } from '../src/home-end.ts';

const HOME = '\x1b[H';
const END = '\x1b[F';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';

function editorWith(text: string): HomeEndEditor {
  const editor = new HomeEndEditor(getEditorTheme());
  editor.setText(text);
  editor.render(80);
  return editor;
}

describe('single-line Home/End insertion', () => {
  it('End appends after the final character when starting inside a word', () => {
    const editor = editorWith('last word');
    editor.handleInput(LEFT);
    editor.handleInput(LEFT);
    editor.handleInput(END);
    editor.handleInput(' ');
    expect(editor.getText()).toBe('last word ');
    expect(editor.getCursor()).toEqual({ line: 0, col: 10 });
  });

  it('Home prepends after a horizontal motion has established a preferred column', () => {
    const editor = editorWith('last word');
    editor.handleInput(LEFT);
    editor.handleInput(HOME);
    editor.handleInput('X');
    expect(editor.getText()).toBe('Xlast word');
    expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
  });

  it('Home and End do not replace the current draft with prompt history', () => {
    const editor = editorWith('current draft');
    editor.addToHistory('previous prompt');
    editor.handleInput(HOME);
    editor.handleInput('X');
    editor.handleInput(END);
    editor.handleInput('!');
    expect(editor.getText()).toBe('Xcurrent draft!');
  });

  it('End preserves a final multi-code-unit grapheme before appended text', () => {
    const editor = editorWith('hello 👩‍💻');
    editor.handleInput(LEFT);
    editor.handleInput(END);
    editor.handleInput('!');
    expect(editor.getText()).toBe('hello 👩‍💻!');
  });

  it('Home and End remain correct after repeated navigation and rendering', () => {
    const editor = editorWith('word');
    for (let i = 0; i < 3; i++) {
      editor.handleInput(HOME);
      editor.render(80);
      editor.handleInput(RIGHT);
      editor.handleInput(END);
      editor.render(80);
    }
    editor.handleInput('!');
    expect(editor.getText()).toBe('word!');
    editor.handleInput(HOME);
    editor.handleInput('>');
    expect(editor.getText()).toBe('>word!');
  });

  it('Home and End permit insertion into an empty draft without recalling history', () => {
    const editor = editorWith('');
    editor.addToHistory('previous prompt');
    editor.handleInput(END);
    editor.handleInput(HOME);
    editor.handleInput('new');
    expect(editor.getText()).toBe('new');
  });
});

describe('whole-draft Ctrl+Home/End insertion', () => {
  it('Ctrl+Home prepends before the first line from the middle of a multiline draft', () => {
    const editor = editorWith('first\nmiddle\nlast');
    editor.handleInput('\x1b[A');
    editor.handleInput('\x1b[1;5H');
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    editor.handleInput('>');
    expect(editor.getText()).toBe('>first\nmiddle\nlast');
  });

  it('Ctrl+End appends after the final grapheme from an earlier line', () => {
    const editor = editorWith('first\nmiddle\nlast 👩‍💻');
    editor.moveToMessageStart();
    editor.handleInput(RIGHT);
    editor.handleInput('\x1b[1;5F');
    expect(editor.getCursor()).toEqual({ line: 2, col: 'last 👩‍💻'.length });
    editor.handleInput('!');
    expect(editor.getText()).toBe('first\nmiddle\nlast 👩‍💻!');
  });

  it('Ctrl+End reaches a trailing empty line and Ctrl+Home preserves leading empty lines', () => {
    const editor = editorWith('\ntext\n');
    editor.moveToMessageStart();
    editor.handleInput('\x1b[8;5~');
    expect(editor.getCursor()).toEqual({ line: 2, col: 0 });
    editor.handleInput('tail');
    editor.handleInput('\x1b[7;5~');
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    editor.handleInput('head');
    expect(editor.getText()).toBe('head\ntext\ntail');
  });

  it('Kitty Ctrl+Home/End cross wrapped rows to the complete draft boundaries', () => {
    const text = `${'wrapped word '.repeat(20)}\nlast`;
    const editor = editorWith(text);
    editor.handleInput('\x1b[1;5:1H');
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    editor.handleInput('>');
    editor.handleInput('\x1b[1;5:1F');
    expect(editor.getCursor()).toEqual({ line: 1, col: 4 });
    editor.handleInput('!');
    expect(editor.getText()).toBe(`>${text}!`);
  });

  it('Ctrl+Home/End keep navigation out of undo history and separate subsequent edits', () => {
    const editor = editorWith('first\nlast');
    editor.handleInput('!');
    editor.handleInput('\x1b[1;5H');
    editor.handleInput('>');
    editor.handleInput('\x1b[1;5F');
    editor.handleInput('?');
    editor.handleInput('\x1b[122;6u');
    expect(editor.getText()).toBe('>first\nlast!');
    editor.handleInput('\x1b[122;6u');
    expect(editor.getText()).toBe('first\nlast!');
  });
});
