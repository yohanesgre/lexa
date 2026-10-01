// @vitest-environment jsdom
// LX-2 coverage: composer picker rows, caps, the five error rows, the
// extraction-failure send block, the kill switch, retry ref replay, and
// sent-message rendering. Pure caps logic is exercised through pickAttachments;
// the composer/strip through the real component.
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { AssistantChatComposer, type ChatUploadRequest } from "./AssistantChatComposer";
import { UserTurnBubble } from "./AssistantChatTurns";
import { useTurnResend } from "./assistant-chat-session";
import type { ChatTurn } from "./assistant-chat-utils";
import { ToastProvider } from "../ui/Toast";
import {
  CHAT_ATTACHMENT_CAPS,
  COUNT_LIMIT_MESSAGE,
  TOTAL_LIMIT_MESSAGE,
  emptyMessage,
  extractionFailedMessage,
  oversizeMessage,
  pickAttachments,
  unsupportedMessage,
  uploadFailedMessage,
  type ChatAttachmentRef,
  type ComposerAttachment,
} from "../../lib/assistant-image";
import type { ChatAttachment } from "../../lib/api";

const MB = 1024 * 1024;

function ready(over: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: "a1",
    kind: "image",
    file: new File([new Uint8Array(1)], "img.png", { type: "image/png" }),
    name: "img.png",
    size: 1024,
    mimeType: "image/png",
    status: "ready",
    progress: 100,
    storageKey: "sk-img",
    ...over,
  };
}

function file(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type });
}

function makeAttachment(req: ChatUploadRequest): ChatAttachment {
  return {
    id: "att-1",
    projectId: "p1",
    chatId: req.chatId,
    filename: req.file.name,
    mimeType: req.file.type,
    sizeBytes: req.file.size,
    sha256: "sha",
    storageKey: "sk-1",
    uploadedBy: null,
    uploadedByLabel: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function composerTree(props: Partial<Parameters<typeof AssistantChatComposer>[0]>) {
  const onSend = props.onSend ?? vi.fn(() => true);
  const uploadAttachment = props.uploadAttachment ?? vi.fn(async (req: ChatUploadRequest) => makeAttachment(req));
  return (
    <AssistantChatComposer
      slug="nimbus"
      streaming={false}
      busy409={false}
      suspendedLock={false}
      suspendCount={0}
      attachDisabled={false}
      onSend={onSend}
      onAbort={() => {}}
      ensureChatId={() => "chat-1"}
      uploadAttachment={uploadAttachment}
      {...props}
    />
  );
}

function renderComposer(props: Partial<Parameters<typeof AssistantChatComposer>[0]> = {}) {
  const onSend = props.onSend ?? vi.fn(() => true);
  const uploadAttachment = props.uploadAttachment ?? vi.fn(async (req: ChatUploadRequest) => makeAttachment(req));
  const utils = render(composerTree({ ...props, onSend, uploadAttachment }));
  return { ...utils, onSend, uploadAttachment };
}

// ── Caps (pure) ────────────────────────────────────────────────────────────

describe("pickAttachments — caps (LX-2 D4)", () => {
  it("accepts up to 3 and warns instead of silently dropping the 4th", () => {
    const current = [ready({ id: "a1" }), ready({ id: "a2" }), ready({ id: "a3" })];
    const result = pickAttachments([file("fourth.png", "image/png", 1000)], current);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejections).toEqual([]);
    expect(result.warning).toBe(COUNT_LIMIT_MESSAGE);
    expect(current).toHaveLength(3);
  });

  it("rejects a per-file over 5 MB with the named limit", () => {
    const result = pickAttachments([file("gameplay-capture.mov", "image/png", 6 * MB)], []);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejections).toEqual([oversizeMessage("gameplay-capture.mov", 6 * MB, CHAT_ATTACHMENT_CAPS)]);
    // The copy reads the cap in whole MB, never hand-rounded.
    expect(result.rejections[0]).toContain("5 MB per-file limit");
  });

  it("rejects a total over 10 MB when count and per-file both pass", () => {
    const current = [ready({ id: "a1", size: 4 * MB }), ready({ id: "a2", size: 4 * MB })];
    const result = pickAttachments([file("chart.png", "image/png", 3 * MB)], current);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejections).toEqual([]);
    expect(result.warning).toBe(TOTAL_LIMIT_MESSAGE);
  });

  it("rejects a zero-byte file even when its type is supported", () => {
    const result = pickAttachments([file("empty.txt", "text/plain", 0)], []);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejections).toEqual([emptyMessage("empty.txt")]);
    expect(result.rejections[0]).toContain("0 bytes");
  });

  it("rejects an unsupported type by name", () => {
    const result = pickAttachments([file("notes.rtf", "application/rtf", 100)], []);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejections).toEqual([unsupportedMessage("notes.rtf")]);
    expect(result.rejections[0]).toContain("unsupported file type");
  });
});

// ── Picker rows ────────────────────────────────────────────────────────────

describe("AssistantChatComposer — attach picker rows", () => {
  it("opens two rows — image and document — with the document row always live", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    const imageRow = screen.getByRole("menuitem", { name: /Attach image/ });
    const documentRow = screen.getByRole("menuitem", { name: /Attach document/ });
    expect(imageRow).toBeEnabled();
    expect(documentRow).toBeEnabled();
    expect(documentRow).toHaveTextContent("pdf · txt · md · csv");
  });

  it("disables the image row with a vision tooltip when images are off, leaving documents live", () => {
    renderComposer({ attachDisabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    const imageRow = screen.getByRole("menuitem", { name: /Attach image/ });
    expect(imageRow).toBeDisabled();
    expect(imageRow).toHaveAttribute("aria-disabled", "true");
    expect(imageRow).toHaveAttribute("title", expect.stringContaining("Images are disabled"));
    expect(imageRow).toHaveAttribute("title", expect.stringContaining("Project Settings"));
    expect(screen.getByRole("menuitem", { name: /Attach document/ })).toBeEnabled();
  });

  it("focuses the first row and moves with ArrowUp/ArrowDown", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    const menu = screen.getByRole("menu");
    const imageRow = screen.getByRole("menuitem", { name: /Attach image/ });
    const documentRow = screen.getByRole("menuitem", { name: /Attach document/ });

    expect(document.activeElement).toBe(imageRow);
    expect(imageRow).toHaveClass("focused");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(documentRow);
    expect(documentRow).toHaveClass("focused");

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(imageRow);
  });

  it("focuses the first ENABLED row when images are disabled", () => {
    renderComposer({ attachDisabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    const menu = screen.getByRole("menu");
    const documentRow = screen.getByRole("menuitem", { name: /Attach document/ });
    expect(document.activeElement).toBe(documentRow);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(documentRow);
  });
});

// ── Error rows (the five fixed copies) ─────────────────────────────────────

describe("AssistantChatComposer — attachment error rows", () => {
  it("renders the unsupported-type rejection row and keeps no chip", () => {
    const { container } = renderComposer();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file("notes.rtf", "application/rtf", 100)] } });
    expect(screen.getByText(unsupportedMessage("notes.rtf"))).toBeTruthy();
    expect(container.querySelector(".deck-attach-item")).toBeNull();
  });

  it("renders the oversize rejection row naming the 5 MB limit", () => {
    const { container } = renderComposer();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file("capture.png", "image/png", 6 * MB)] } });
    expect(screen.getByText(oversizeMessage("capture.png", 6 * MB, CHAT_ATTACHMENT_CAPS))).toBeTruthy();
  });

  it("renders the zero-byte rejection row", () => {
    const { container } = renderComposer();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file("empty.txt", "text/plain", 0)] } });
    expect(screen.getByText(emptyMessage("empty.txt"))).toBeTruthy();
  });

  it("renders the upload-failed row with a Retry that re-uploads the same file", async () => {
    const uploadAttachment = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { code: "STORAGE_ERROR" });
    });
    const { container } = renderComposer({ uploadAttachment });
    fireEvent.change(container.querySelectorAll('input[type="file"]')[1]!, { target: { files: [file("design-spec.pdf", "application/pdf", 2048)] } });

    await waitFor(() => expect(screen.getByText(uploadFailedMessage("design-spec.pdf"))).toBeTruthy());
    expect(container.querySelector(".deck-attach-item")).toBeNull();
    expect(uploadAttachment).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(2));
  });

  it("marks the named document unreadable and blocks Send until it is removed", async () => {
    const onSend = vi.fn(() => true);
    const props: Partial<Parameters<typeof AssistantChatComposer>[0]> = {
      onSend,
      initialAttachments: [ready({ id: "d1", kind: "document", name: "scanned-contract.pdf", mimeType: "application/pdf", size: 2048, storageKey: "sk-doc" })],
    };
    const { container, rerender } = render(composerTree(props));
    fireEvent.change(screen.getByLabelText("Message Assistant"), { target: { value: "summarize this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("summarize this", [expect.objectContaining({ storageKey: "sk-doc" })]);

    rerender(composerTree({ ...props, sendError: { code: "ATTACHMENT_EXTRACTION_FAILED", details: { filename: "scanned-contract.pdf" } } }));

    await waitFor(() => expect(screen.getByText(extractionFailedMessage("scanned-contract.pdf"))).toBeTruthy());
    expect(container.querySelector(".deck-attach-item")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

// ── Caps warnings in the strip ─────────────────────────────────────────────

describe("AssistantChatComposer — strip caps warnings", () => {
  it("warns at the count cap and marks the meter over", () => {
    const { container } = renderComposer({
      initialAttachments: [ready({ id: "a1" }), ready({ id: "a2" }), ready({ id: "a3" })],
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file("fourth.png", "image/png", 1000)] } });

    expect(screen.getByText(COUNT_LIMIT_MESSAGE)).toBeTruthy();
    expect(container.querySelector(".deck-meter.is-over")).toBeTruthy();
    expect(container.querySelectorAll(".deck-attach-item")).toHaveLength(3);
  });

  it("warns at the total cap without adding the file", () => {
    const { container } = renderComposer({
      initialAttachments: [ready({ id: "a1", size: 4 * MB }), ready({ id: "a2", size: 4 * MB })],
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file("chart.png", "image/png", 3 * MB)] } });

    expect(screen.getByText(TOTAL_LIMIT_MESSAGE)).toBeTruthy();
    expect(container.querySelectorAll(".deck-attach-item")).toHaveLength(2);
  });

  it("clears a stale caps warning on a later successful pick", () => {
    const { container } = renderComposer({
      initialAttachments: [ready({ id: "a1", size: 4 * MB }), ready({ id: "a2", size: 4 * MB })],
    });
    const input = container.querySelector('input[type="file"]')!;

    fireEvent.change(input, { target: { files: [file("chart.png", "image/png", 3 * MB)] } });
    expect(screen.getByText(TOTAL_LIMIT_MESSAGE)).toBeTruthy();

    fireEvent.change(input, { target: { files: [file("notes.png", "image/png", 1 * MB)] } });
    expect(screen.queryByText(TOTAL_LIMIT_MESSAGE)).toBeNull();
  });
});

// ── Thread id minting (multi-file pick) ─────────────────────────────────────

describe("AssistantChatComposer — thread id per pick", () => {
  it("mints ONE thread id for a multi-file pick so every upload shares the thread", async () => {
    const uploadAttachment = vi.fn(async (req: ChatUploadRequest) => makeAttachment(req));
    let n = 0;
    const ensureChatId = vi.fn(() => `chat-${++n}`);
    const { container } = renderComposer({ ensureChatId, uploadAttachment });

    fireEvent.change(container.querySelectorAll('input[type="file"]')[0]!, {
      target: { files: [file("a.png", "image/png", 1000), file("b.png", "image/png", 1000)] },
    });

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(2));
    expect(ensureChatId).toHaveBeenCalledTimes(1);
    expect(uploadAttachment.mock.calls.map((call) => call[0].chatId)).toEqual(["chat-1", "chat-1"]);
  });
});

// ── Kill switch ────────────────────────────────────────────────────────────

describe("AssistantChatComposer — kill switch", () => {
  it("renders no attach control, strip, or meter when the deployment disables attachments", () => {
    const { container } = renderComposer({
      attachmentsEnabled: false,
      initialAttachments: [ready({ id: "a1" })],
    });
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.querySelector(".deck-attach")).toBeNull();
    expect(container.querySelector(".deck-attach-item")).toBeNull();
    expect(container.querySelector(".deck-meter")).toBeNull();
  });
});

// ── Retry replays the original refs (D6) ───────────────────────────────────

describe("useTurnResend — attachment ref replay", () => {
  it("replays a user turn's original refs on retry", () => {
    const refs: ChatAttachmentRef[] = [{ storageKey: "sk1", mimeType: "application/pdf", name: "spec.pdf", sizeBytes: 100 }];
    const errorTurn: ChatTurn = { role: "assistant", text: "", imageCount: 0, rawIndex: 1, error: { code: "PROVIDER_UNREACHABLE", message: "x" } };
    const userTurn: ChatTurn = { role: "user", text: "hello", imageCount: 0, rawIndex: 0, attachments: refs };
    const raw = [{ role: "user", content: "hello" }, { role: "assistant", content: "" }];
    const startStream = vi.fn();
    const { result } = renderHook(
      () => useTurnResend({ turns: [userTurn, errorTurn], setTurns: vi.fn(), rawMessages: raw, streaming: false, startStream }),
      { wrapper: ({ children }) => <ToastProvider>{children}</ToastProvider> }
    );
    act(() => result.current.handleRetryTurn(errorTurn));
    expect(startStream).toHaveBeenCalledWith("hello", refs, 0);
  });
});

// ── Sent-message rendering ─────────────────────────────────────────────────

describe("UserTurnBubble — sent attachments", () => {
  const base = {
    pos: 0,
    slug: "nimbus",
    editing: false,
    editDraft: "",
    onEditDraftChange: () => {},
    onBeginEdit: () => {},
    onCancelEdit: () => {},
    onCommitEdit: () => {},
    lastUser: true,
    streaming: false,
    onRegenerate: () => {},
  };

  it("renders an image thumbnail and a document chip", () => {
    const turn: ChatTurn = {
      role: "user",
      text: "see the files",
      imageCount: 1,
      rawIndex: 0,
      attachments: [
        { storageKey: "sk-img", mimeType: "image/png", name: "board-crash.png", sizeBytes: 1234, previewUrl: "blob:img" },
        { storageKey: "sk-doc", mimeType: "application/pdf", name: "payments-migration-spec.pdf", sizeBytes: 340 * 1024 },
      ],
    };
    const { container } = render(<UserTurnBubble turn={turn} {...base} />);

    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.alt).toBe("board-crash.png");
    expect(img.getAttribute("src")).toBe("blob:img");
    const chip = container.querySelector(".deck-attach-item")!;
    expect(chip).toHaveTextContent("payments-migration-spec.pdf");
    expect(chip).toHaveTextContent("340KB");
  });

  it("resolves a reloaded image through the conversation-scoped serve URL", () => {
    const turn: ChatTurn = {
      role: "user",
      text: "reloaded",
      imageCount: 1,
      rawIndex: 0,
      attachments: [{ storageKey: "sk-img", mimeType: "image/png", name: "board-crash.png" }],
    };
    const index = new Map<string, ChatAttachment>([
      [
        "sk-img",
        {
          id: "att-9",
          projectId: "p1",
          chatId: "A",
          filename: "board-crash.png",
          mimeType: "image/png",
          sizeBytes: 1234,
          sha256: "sha",
          storageKey: "sk-img",
          uploadedBy: null,
          uploadedByLabel: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const { container } = render(<UserTurnBubble turn={turn} {...base} attachmentIndex={index} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/chat-attachments/att-9");
  });
});
