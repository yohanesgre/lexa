import { OutlineList } from "./OutlineList";
import type { HeadingOutline } from "../../lib/markdownToReact";

interface OutlineRailProps {
  headings: HeadingOutline[];
  activeId: string;
  onSelect: (id: string) => void;
}

// The persistent section navigator beside the document (DESIGN.md §5 of the
// wiki design review): a Signage plate over the section rows, sticky inside the
// read area so it holds position while the document scrolls.
export function OutlineRail({ headings, activeId, onSelect }: OutlineRailProps) {
  return (
    <nav className="wiki-outline-rail" aria-label="On this page">
      <div className="wiki-rail-plate">On this page</div>
      <OutlineList headings={headings} activeId={activeId} onSelect={onSelect} />
    </nav>
  );
}
