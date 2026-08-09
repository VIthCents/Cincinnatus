import { useEffect, useRef, useState } from "react";
import type { LlmMessage } from "../../core/ports.ts";
import type { Critique, Finding, ResumeData } from "../../core/documents/types.ts";
import { chatTurn } from "../../core/chat/agent.ts";
import { analyzeResume } from "../../core/documents/analyze.ts";
import { parseResume } from "../../core/documents/parseResume.ts";
import { reviseResume } from "../../core/documents/revise.ts";
import * as repo from "../../core/db/repo.ts";

import { llmErrorMessage } from "../../tauri/llm.ts";
import { tauriClock, tauriHasher } from "../../tauri/clock.ts";

import { db, getLlm } from "../app/services.ts";
import { runSearchNow } from "../app/searchRunner.ts";
import { useAppDispatch, useAppState, type ChatEntry } from "../app/state.tsx";
import { adoptBaseResume, saveResumeDocx } from "../documents/actions.ts";
import { FindingsList } from "../documents/FindingsList.tsx";
import { ResumeView } from "../documents/ResumeView.tsx";
import { usePrint } from "../documents/print.tsx";
import { Icon } from "../components/Icon.tsx";
import { Button, PrimaryButton } from "../components/ui.tsx";

/** Ported from the design system (components/chat/TypingIndicator.jsx). */
function TypingIndicator({ label = "Cincinnatus is writing…" }: { label?: string }) {
  return (
    <div className="cn-typing" role="status" aria-live="polite">
      <span className="cn-typing__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </div>
  );
}

/**
 * The Chat tab (SPEC §8). Free text goes to the scoped chat model; the three
 * chips are wired straight to engine functions — deterministic, testable, and
 * immune to a chat message talking the app into something else.
 */

let nextId = 0;
function entryId(): string {
  nextId += 1;
  return `chat-${Date.now()}-${nextId}`;
}

/** The critique as plain text, so the persisted message is self-sufficient. */
function critiqueToText(critique: Critique): string {
  const lines: string[] = [critique.summary, "", "What is working:"];
  for (const s of critique.strengths) lines.push(`• ${s}`);
  lines.push("", "What is holding it back:");
  for (const g of critique.gaps) lines.push(`• ${g}`);
  lines.push("", "What to fix, one at a time:");
  critique.fixes.forEach((fix, i) => {
    lines.push(`${i + 1}. ${fix.what}`);
    lines.push(`   Why: ${fix.why}`);
    lines.push(`   How: ${fix.how}`);
  });
  return lines.join("\n");
}

export function ChatTab() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const print = usePrint();
  const [draft, setDraft] = useState("");
  const [reviseMode, setReviseMode] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [state.chat.length, state.chatBusy]);

  function add(entry: ChatEntry, relatedDocumentId: string | null = null) {
    dispatch({ type: "chat_add", entry });
    void repo.saveChatMessage(
      db,
      {
        id: entry.id,
        role: entry.role,
        content: entry.content,
        ts: tauriClock.now(),
      },
      relatedDocumentId,
    );
  }

  function say(
    content: string,
    card: ChatEntry["card"] = null,
    relatedDocumentId: string | null = null,
  ) {
    add({ id: entryId(), role: "assistant", content, card }, relatedDocumentId);
  }

  async function needLlm() {
    const llm = await getLlm();
    if (llm === null) {
      say(
        "That needs the AI helper, and no key is connected yet. You can add one in Settings — the job search works without it.",
      );
    }
    return llm;
  }

  /** The veteran's resume text: parsed base resume, or pending raw text. */
  async function currentResumeSource(): Promise<
    { kind: "parsed"; resume: ResumeData } | { kind: "raw"; text: string } | null
  > {
    if (state.resume !== null) return { kind: "parsed", resume: state.resume };
    const pending = await repo.getSetting(db, "pending_resume_text");
    if (pending !== null) return { kind: "raw", text: pending };
    return null;
  }

  async function handleAnalyze() {
    const llm = await needLlm();
    if (llm === null) return;
    const source = await currentResumeSource();
    if (source === null) {
      say(
        "I don't have your resume yet. Add it in the setup, or paste the text here and I'll read it.",
      );
      return;
    }
    dispatch({ type: "chat_busy", busy: true });
    try {
      // Make sure a structured base resume exists for later steps.
      if (source.kind === "raw") {
        const parsed = await parseResume(llm, source.text);
        await adoptBaseResume(parsed);
        await repo.setSetting(db, "base_resume_raw_text", source.text);
        dispatch({ type: "resume", resume: parsed });
      }
      const rawText =
        source.kind === "raw"
          ? source.text
          : ((await repo.getSetting(db, "base_resume_raw_text")) ??
            JSON.stringify(source.resume, null, 2));
      const critique = await analyzeResume(llm, rawText);
      // The persisted content is the full critique as plain text, so the
      // message still reads complete after a restart (cards are not stored).
      say(critiqueToText(critique), {
        kind: "critique",
        critiqueJson: JSON.stringify(critique),
      });
    } catch (err) {
      say(llmErrorMessage(err));
    } finally {
      dispatch({ type: "chat_busy", busy: false });
    }
  }

  async function handleReviseInstruction(instruction: string) {
    const llm = await needLlm();
    if (llm === null) return;
    if (state.resume === null) {
      say("I need your resume first. Use “Look over my resume” and I'll read it in.");
      return;
    }
    dispatch({ type: "chat_busy", busy: true });
    try {
      const result = await reviseResume(llm, state.resume, instruction);
      // Persist the revised resume as a document BEFORE showing the card, and
      // link the message to it — so closing the app before clicking "Use this
      // as my resume" loses nothing: boot() rebuilds the card from this row.
      const resumeJson = JSON.stringify(result.document);
      const documentId = tauriHasher.sha256Hex(
        `final_resume:${tauriClock.now()}:${resumeJson.length}`,
      );
      await repo.saveDocument(
        db,
        { id: documentId, kind: "final_resume", jobId: null, content: resumeJson },
        tauriClock.now(),
      );
      say(
        result.note,
        {
          kind: "resume",
          resumeJson,
          note: result.note,
          findingsJson: JSON.stringify(result.findings),
        },
        documentId,
      );
    } catch (err) {
      say(llmErrorMessage(err));
    } finally {
      dispatch({ type: "chat_busy", busy: false });
    }
  }

  async function handleFreeText(text: string) {
    const llm = await needLlm();
    if (llm === null) return;
    dispatch({ type: "chat_busy", busy: true });
    try {
      const history: LlmMessage[] = state.chat.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const { reply } = await chatTurn(llm, {
        history,
        userMessage: text,
        resume: state.resume,
      });
      say(reply);
    } catch (err) {
      say(llmErrorMessage(err));
    } finally {
      dispatch({ type: "chat_busy", busy: false });
    }
  }

  function submit() {
    const text = draft.trim();
    if (text === "" || state.chatBusy) return;
    setDraft("");
    add({ id: entryId(), role: "user", content: text, card: null });
    if (reviseMode) {
      setReviseMode(false);
      void handleReviseInstruction(text);
    } else {
      void handleFreeText(text);
    }
  }

  const CHIPS = [
    { label: "Look over my resume", run: () => void handleAnalyze() },
    {
      label: "Find me jobs",
      run: () => {
        dispatch({ type: "tab", tab: "jobs" });
        void runSearchNow(dispatch);
      },
    },
    { label: "Make my resume better", run: () => setReviseMode(true) },
  ];

  return (
    <div className="chat">
      <div className="chat__scroll">
        <div className="cn-chat">
          {state.chat.length === 0 && (
            <div className="cn-bubble cn-bubble--agent">
              <span className="cn-bubble__who">Cincinnatus</span>
              Hello. I am here to help with your resume and your job search. Pick one of
              the buttons below, or just tell me what is going on.
            </div>
          )}
          {state.chat.map((entry) => (
            <ChatBubble key={entry.id} entry={entry} onPrint={print} />
          ))}
          {state.chatBusy && <TypingIndicator />}
          {reviseMode && (
            <div className="cn-bubble cn-bubble--agent">
              <span className="cn-bubble__who">Cincinnatus</span>
              Tell me what to change, and I will do it without touching anything else.
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="chat__foot">
        <div className="cn-chips">
          {CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className="cn-chip"
              disabled={state.chatBusy}
              onClick={chip.run}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <form
          className="cn-composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            aria-label="Message Cincinnatus"
            className="cn-composer__input"
            rows={1}
            placeholder={reviseMode ? "What should I change?" : "Type here..."}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter makes a new line. A textarea that
              // only sends on a button click hides the obvious action.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button
            icon="arrow_forward"
            size="md"
            disabled={state.chatBusy || draft.trim() === ""}
            onClick={submit}
          >
            Send
          </Button>
        </form>
        <p className="chat__note">
          What you type stays on this computer, except the words Cincinnatus sends to
          the AI when you ask it for help.
        </p>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function ChatBubble({
  entry,
  onPrint,
}: {
  entry: ChatEntry;
  onPrint: (node: React.ReactNode) => void;
}) {
  const isUser = entry.role === "user";
  // When the pretty critique card is live, don't ALSO show its plain-text twin
  // (the text form exists so the persisted message survives restarts).
  const displayContent =
    entry.card?.kind === "critique"
      ? "Here is my honest read of your resume."
      : entry.content;

  // Cards sit in the transcript beside the bubble, not inside it: the bubble
  // is pre-wrapped text, and nesting a card in it inherits that whitespace.
  return (
    <>
      <div className={`cn-bubble cn-bubble--${isUser ? "user" : "agent"}`}>
        <span className="cn-bubble__who">{isUser ? "You" : "Cincinnatus"}</span>
        {displayContent}
      </div>
      {entry.card?.kind === "critique" && (
        <CritiqueCard critique={JSON.parse(entry.card.critiqueJson) as Critique} />
      )}
      {entry.card?.kind === "resume" && (
        <ResumeCard
          resume={JSON.parse(entry.card.resumeJson) as ResumeData}
          findings={JSON.parse(entry.card.findingsJson) as Finding[]}
          onPrint={onPrint}
        />
      )}
    </>
  );
}

function CritiqueCard({ critique }: { critique: Critique }) {
  return (
    <div className="doc">
      <div className="doc__head">
        <Icon name="description" size={20} />
        What I found
      </div>
      <div className="doc__body">
        <p>{critique.summary}</p>
        <div>
          <h4>What is working</h4>
          <ul>
            {critique.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4>What is holding it back</h4>
          <ul>
            {critique.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4>What to fix, one at a time</h4>
          <ol>
            {critique.fixes.map((fix, i) => (
              <li key={i}>
                <p>{fix.what}</p>
                <p className="doc__meta">Why: {fix.why}</p>
                <p className="doc__meta">How: {fix.how}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function ResumeCard({
  resume,
  findings,
  onPrint,
}: {
  resume: ResumeData;
  findings: readonly Finding[];
  onPrint: (node: React.ReactNode) => void;
}) {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  return (
    <div className="stack stack--tight">
      <FindingsList findings={findings} context="authored" />

      <div className="cn-doc">
        <span className="cn-doc__icon" aria-hidden="true">
          <Icon name="description" size={26} />
        </span>
        <span className="cn-doc__text">
          <span className="cn-doc__name">Your revised resume</span>
          <span className="cn-doc__meta">
            {adopted ? "This is your resume now" : "Not saved as your resume yet"}
          </span>
        </span>
        <span className="cn-doc__actions">
          <Button
            variant="secondary"
            size="md"
            onClick={() => setOpen(!open)}
            ariaLabel={open ? "Hide the revised resume" : "View the revised resume"}
          >
            {open ? "Hide" : "View"}
          </Button>
          <Button
            variant="quiet"
            size="md"
            onClick={() => {
              void saveResumeDocx(resume).then((path) => setSavedTo(path));
            }}
            ariaLabel="Save the revised resume as a Word file"
          >
            Save
          </Button>
          <Button
            variant="quiet"
            size="md"
            onClick={() => onPrint(<ResumeView resume={resume} />)}
            ariaLabel="Print the revised resume"
          >
            Print
          </Button>
        </span>
      </div>

      {open && (
        <div className="doc">
          <div className="doc__body">
            <ResumeView resume={resume} />
          </div>
        </div>
      )}

      <div className="row">
        <PrimaryButton
          size="md"
          icon="check"
          disabled={adopted}
          onClick={() => {
            void adoptBaseResume(resume).then(() => {
              dispatch({ type: "resume", resume });
              setAdopted(true);
            });
          }}
        >
          {adopted ? "This is your resume now" : "Use this as my resume"}
        </PrimaryButton>
      </div>

      {savedTo !== null && (
        <p className="prose--muted">Your resume is saved. Look in {savedTo}.</p>
      )}
    </div>
  );
}
