import type { Finding } from "../../core/documents/types.ts";
import { Notice } from "../components/ui.tsx";

/**
 * The no-fabrication check's findings, as simple confirmations (SPEC §8:
 * "entity-check flags surfaced as simple confirmations"). The wording differs
 * by trust model: derived documents (tailor, letter) treat additions as
 * stop-and-look problems; authored changes (revise) as things to confirm.
 */
export function FindingsList({
  findings,
  context,
}: {
  findings: readonly Finding[];
  context: "derived" | "authored";
}) {
  const high = findings.filter((f) => f.severity === "high");
  const review = findings.filter((f) => f.severity === "review");

  if (findings.length === 0) {
    return (
      <Notice>Checked against your resume: nothing was added that is not yours.</Notice>
    );
  }

  return (
    <div className="space-y-3">
      {high.length > 0 && (
        <Notice tone="warn">
          <p className="font-semibold">
            {context === "derived"
              ? "Stop — these things are not backed by your resume:"
              : "Please check these changes:"}
          </p>
          <ul className="ml-5 mt-1 list-disc">
            {high.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
          {context === "derived" && (
            <p className="mt-2">
              Do not send this out until they are fixed. Fix your resume first, or make
              the document again.
            </p>
          )}
        </Notice>
      )}
      {review.length > 0 && (
        <Notice>
          <p className="font-semibold">Worth a quick look:</p>
          <ul className="ml-5 mt-1 list-disc">
            {review.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}
