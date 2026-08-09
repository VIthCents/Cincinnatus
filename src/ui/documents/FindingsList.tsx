import type { Finding } from "../../core/documents/types.ts";
import { Banner } from "../components/ui.tsx";

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
      <Banner tone="success" title="Checked against your resume.">
        Nothing was added that is not yours.
      </Banner>
    );
  }

  return (
    <div className="stack stack--tight">
      {high.length > 0 && (
        <Banner
          // A derived document that claims something the resume does not
          // support is the failure this whole check exists to catch, so it is
          // an error and it interrupts. An authored change is the person's own
          // instruction coming back to them: worth confirming, not alarming.
          tone={context === "derived" ? "error" : "caution"}
          title={
            context === "derived"
              ? "Stop — these things are not backed by your resume."
              : "Please check these changes."
          }
        >
          <ul className="findings">
            {high.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
          {context === "derived" && (
            <p>
              Do not send this out until they are fixed. Fix your resume first, or make
              the document again.
            </p>
          )}
        </Banner>
      )}
      {review.length > 0 && (
        <Banner tone="info" title="Worth a quick look.">
          <ul className="findings">
            {review.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        </Banner>
      )}
    </div>
  );
}
