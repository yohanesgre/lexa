import type { ReactNode } from "react";
import { AssistantFlameIcon } from "../assistant/panel/AssistantFlameIcon";

// New-chat landing (assistant-chat-deck design §3.5): hero glyph + heading +
// scope subline, the Deck centered, and three starter chips under it. Chips only
// PREFILL the composer — they never send. The landing renders only at zero
// turns with a provider configured; the first send docks the Deck.
const STARTER_CHIPS = ["Summarize the board", "Create a task from my notes", "Find related wiki pages"];

export function ChatLanding({ landing, onPickStarter, children }: { landing: boolean; onPickStarter: (text: string) => void; children?: ReactNode }) {
  return (
    <div className={landing ? "chat-landing" : "contents"}>
      {landing && <>
      <div className="chat-landing-hero">
        <AssistantFlameIcon size={22} />
      </div>
      <div className="chat-landing-title">What should we get done?</div>
      <div className="text-xs text-lx-text-secondary">Reads this project's tasks, wiki and activity.</div>
      </>}
      {children}
      {landing && <div className="chat-landing-chips">
        {STARTER_CHIPS.map((chip) => (
          <button key={chip} type="button" className="chat-landing-chip" onClick={() => onPickStarter(chip)}>
            {chip}
          </button>
        ))}
      </div>}
    </div>
  );
}
