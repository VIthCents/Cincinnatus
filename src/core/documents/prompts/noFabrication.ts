/**
 * Constraint 4, as prompt text. Every document-generation prompt embeds this
 * block verbatim — SPEC §1 requires the rule to travel with every such prompt,
 * and tests/documents.test.ts asserts its presence in each of them.
 *
 * The deterministic backstop is src/core/documents/verify.ts: even if a model
 * ignores this, the entity check catches additions before the user sees them.
 */
export const NO_FABRICATION_RULE = `THE ONE RULE THAT OVERRIDES EVERYTHING ELSE:
Never invent facts. You may reorder, rephrase, emphasize, shorten, and translate
military experience into civilian language. You may NEVER add an employer, job
title, date, degree, school, certification, license, security clearance, or
accomplishment that is not in the material you were given. If something is
missing, leave it missing. This matters doubly for federal applications, where a
false statement on an application is a crime. When in doubt, leave it out.`;
