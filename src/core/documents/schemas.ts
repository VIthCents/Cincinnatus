/**
 * JSON Schemas passed to the Llm port's `jsonSchema` option.
 *
 * The adapter enforces these via the API's structured outputs, so the engine
 * never parses free text and a malformed response is impossible rather than
 * handled. Rules the API imposes: `additionalProperties: false` on every
 * object, every key listed in `required`, nullability via `type: [X, "null"]`.
 */

const STRING = { type: "string" } as const;
const NULLABLE_STRING = { type: ["string", "null"] } as const;
const STRING_ARRAY = { type: "array", items: STRING } as const;

export const RESUME_DATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "email",
    "phone",
    "location",
    "summary",
    "experience",
    "education",
    "certifications",
    "skills",
    "clearance",
    "militaryCodes",
  ],
  properties: {
    name: STRING,
    email: NULLABLE_STRING,
    phone: NULLABLE_STRING,
    location: NULLABLE_STRING,
    summary: NULLABLE_STRING,
    experience: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "org",
          "title",
          "location",
          "start",
          "end",
          "hoursPerWeek",
          "bullets",
        ],
        properties: {
          org: STRING,
          title: STRING,
          location: NULLABLE_STRING,
          start: NULLABLE_STRING,
          end: NULLABLE_STRING,
          hoursPerWeek: { type: ["number", "null"] },
          bullets: STRING_ARRAY,
        },
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["institution", "credential", "year"],
        properties: {
          institution: STRING,
          credential: STRING,
          year: NULLABLE_STRING,
        },
      },
    },
    certifications: STRING_ARRAY,
    skills: STRING_ARRAY,
    clearance: NULLABLE_STRING,
    militaryCodes: STRING_ARRAY,
  },
} as const;

/** Revise and tailor return the whole updated resume plus a note. */
export const RESUME_WITH_NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["resume", "note"],
  properties: {
    resume: RESUME_DATA_SCHEMA,
    note: STRING,
  },
} as const;

export const CRITIQUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "strengths", "gaps", "fixes"],
  properties: {
    summary: STRING,
    strengths: STRING_ARRAY,
    gaps: STRING_ARRAY,
    fixes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "why", "how"],
        properties: { what: STRING, why: STRING, how: STRING },
      },
    },
  },
} as const;

export const COVER_LETTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["salutation", "bodyParagraphs", "closing"],
  properties: {
    salutation: STRING,
    bodyParagraphs: STRING_ARRAY,
    closing: {
      type: "string",
      description:
        "The valediction only, e.g. 'Sincerely,'. Do NOT include the applicant's name — every renderer prints it on the next line, so a name here signs the letter twice.",
    },
  },
} as const;
