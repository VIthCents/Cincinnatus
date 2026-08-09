import { useEffect, useRef, useState } from "react";
import type { LlmMessage } from "../../core/ports.ts";
import type { Critique, Finding, ResumeData } from "../../core/documents/types.ts";
import { chatTurn } from "../../core/chat/agent.ts";
import { analyzeResume } from "../../core/documents/analyze.ts";
import { parseResume } from "../../core/documents/parseResume.ts";
import { reviseResume } from "../../core/documents/revise.ts";
import * as repo from "../../core/db/repo.ts";

import { llmErrorMessage } from "../../tauri/llm.ts";
import { tauriClock } from "../../tauri/clock.ts";

import { db, getLlm } from "../app/services.ts";
import { runSearchNow } from "../app/searchRunner.ts";
import { useAppDispatch, useAppState, type ChatEntry } from "../app/state.tsx";
import { adoptBaseResume, saveResumeDocx } from "../documents/actions.ts";
import { FindingsList } from "../documents/FindingsList.tsx";
import { ResumeView } from "../documents/ResumeView.tsx";
import { usePrint } from "../documents/print.tsx";
import { Busy, Notice, PrimaryButton, QuietButton } from "../components/ui.tsx";

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

  function add(entry: ChatEntry, persist = true) {
    dispatch({ type: "chat_add", entry });
    if (persist) {
      void repo.saveChatMessage(db, {
        id: entry.id,
        role: entry.role,
        content: entry.content,
        ts: tauriClock.now(),
      });
    }
  }

  function say(content: string, card: ChatEntry["card"] = null) {
    add({ id: entryId(), role: "assistant", content, card });
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
      say("Here's my honest read of your resume:", {
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
      say(result.note, {
        kind: "resume",
        resumeJson: JSON.stringify(result.document),
        note: result.note,
        findingsJson: JSON.stringify(result.findings),
      });
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

  return (
    <div className="flex h-full flex-col">
      <div className="grow space-y-4 overflow-y-auto p-6">
        {state.chat.length === 0 && (
          <Notice>
            Hi — I'm here to help with your resume and your job search. Try one of the
            buttons below, or just tell me what's going on.
          </Notice>
        )}
        {state.chat.map((entry) => (
          <ChatBubble key={entry.id} entry={entry} onPrint={print} />
        ))}
        {state.chatBusy && <Busy label="Thinking..." />}
        {reviseMode && (
          <Notice>
            Tell me what to change, and I'll do it without touching anything else.
          </Notice>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-slate-200 p-4">
        <div className="mb-3 flex flex-wrap gap-2">
          <QuietButton disabled={state.chatBusy} onClick={() => void handleAnalyze()}>
            Look over my resume
          </QuietButton>
          <QuietButton
            disabled={state.chatBusy}
            onClick={() => {
              dispatch({ type: "tab", tab: "jobs" });
              void runSearchNow(dispatch);
            }}
          >
            Find me jobs
          </QuietButton>
          <QuietButton disabled={state.chatBusy} onClick={() => setReviseMode(true)}>
            Make my resume better
          </QuietButton>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            aria-label="Message Cincinnatus"
            className="grow rounded-lg border border-slate-300 px-4 py-3 text-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-400"
            placeholder={reviseMode ? "What should I change?" : "Type here..."}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <PrimaryButton
            disabled={state.chatBusy || draft.trim() === ""}
            onClick={submit}
          >
            Send
          </PrimaryButton>
        </form>
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
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl bg-blue-700 px-4 py-3 text-lg text-white"
            : "max-w-[85%] rounded-2xl bg-slate-100 px-4 py-3 text-lg"
        }
      >
        <p className="whitespace-pre-wrap">{entry.content}</p>
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
      </div>
    </div>
  );
}

function CritiqueCard({ critique }: { critique: Critique }) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-slate-300 bg-white p-4 text-base">
      <p>{critique.summary}</p>
      <div>
        <p className="font-semibold">What's working:</p>
        <ul className="ml-5 list-disc">
          {critique.strengths.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-semibold">What's holding it back:</p>
        <ul className="ml-5 list-disc">
          {critique.gaps.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-semibold">What to fix, one at a time:</p>
        <ol className="ml-5 list-decimal space-y-2">
          {critique.fixes.map((fix, i) => (
            <li key={i}>
              <p>{fix.what}</p>
              <p className="text-slate-600">Why: {fix.why}</p>
              <p className="text-slate-600">How: {fix.how}</p>
            </li>
          ))}
        </ol>
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
    <div className="mt-3 space-y-3 rounded-lg border border-slate-300 bg-white p-4">
      <FindingsList findings={findings} context="authored" />
      {open && (
        <div className="max-h-96 overflow-y-auto rounded border border-slate-200 p-3">
          <ResumeView resume={resume} />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <QuietButton onClick={() => setOpen(!open)}>
          {open ? "Hide it" : "View it"}
        </QuietButton>
        <PrimaryButton
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
        <QuietButton
          onClick={() => {
            void saveResumeDocx(resume).then((path) => setSavedTo(path));
          }}
        >
          Save as a Word file
        </QuietButton>
        <QuietButton onClick={() => onPrint(<ResumeView resume={resume} />)}>
          Print
        </QuietButton>
      </div>
      {savedTo !== null && (
        <p className="text-base text-slate-600">Saved to {savedTo}</p>
      )}
    </div>
  );
}
