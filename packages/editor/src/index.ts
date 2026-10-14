import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { HomeEndEditor } from './home-end.ts';

export default function editor(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new HomeEndEditor(tui, theme, keybindings),
    );
  });
}
