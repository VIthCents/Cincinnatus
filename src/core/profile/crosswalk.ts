import crosswalkData from "../../../data/crosswalk.json" with { type: "json" };

/**
 * Military occupation code → civilian job titles.
 *
 * PROVENANCE. This is the hand-built fallback SPEC section 6 explicitly allows
 * for Phase 1 ("commit a hand-built sample covering common MOS families so the
 * pipeline works end-to-end, and log a TODO"). It is NOT the full O*NET
 * crosswalk.
 *
 * COVERAGE. The 17 entries below are hand-written; data/crosswalk.json adds
 * 7,178 more, generated from O*NET by scripts/build-crosswalk.ts. The hand-
 * written ones override the generated ones, because they were chosen against
 * what a veteran actually types into a job search.
 *
 * Entries are keyed by bare code, upper-cased. Codes collide across branches —
 * a four-digit USMC MOS can equal a Navy officer designator — so the generated
 * version will key on branch+code and treat a bare code as the union. For this
 * hand-built subset the families below do not collide.
 *
 * The titles are what a veteran would actually search for, not O*NET's formal
 * SOC titles: "Truck Driver" finds jobs, "Heavy and Tractor-Trailer Truck
 * Drivers" mostly does not.
 */

export interface CrosswalkEntry {
  /** Bare occupation code, upper-case. */
  readonly code: string;
  /** Branches this code belongs to, for display. */
  readonly branches: readonly string[];
  readonly militaryTitle: string;
  /** Civilian search titles, most transferable first. */
  readonly civilianTitles: readonly string[];
}

export const CROSSWALK: readonly CrosswalkEntry[] = [
  // --- Infantry ---------------------------------------------------------
  {
    code: "11B",
    branches: ["Army"],
    militaryTitle: "Infantryman",
    civilianTitles: [
      "Security Officer",
      "Police Officer",
      "Operations Supervisor",
      "Emergency Management Specialist",
      "Correctional Officer",
    ],
  },
  {
    code: "0311",
    branches: ["Marine Corps"],
    militaryTitle: "Rifleman",
    civilianTitles: [
      "Security Officer",
      "Police Officer",
      "Operations Supervisor",
      "Emergency Management Specialist",
    ],
  },

  // --- Motor transport --------------------------------------------------
  {
    code: "88M",
    branches: ["Army"],
    militaryTitle: "Motor Transport Operator",
    civilianTitles: [
      "Truck Driver",
      "CDL Driver",
      "Delivery Driver",
      "Fleet Supervisor",
      "Dispatcher",
    ],
  },
  {
    code: "3531",
    branches: ["Marine Corps"],
    militaryTitle: "Motor Vehicle Operator",
    civilianTitles: ["Truck Driver", "CDL Driver", "Delivery Driver", "Dispatcher"],
  },

  // --- Vehicle maintenance ----------------------------------------------
  {
    code: "91B",
    branches: ["Army"],
    militaryTitle: "Wheeled Vehicle Mechanic",
    civilianTitles: [
      "Diesel Mechanic",
      "Automotive Technician",
      "Fleet Maintenance Technician",
      "Field Service Technician",
      "Maintenance Technician",
    ],
  },

  // --- Communications and IT --------------------------------------------
  {
    code: "25B",
    branches: ["Army"],
    militaryTitle: "Information Technology Specialist",
    civilianTitles: [
      "IT Support Specialist",
      "Help Desk Technician",
      "Network Administrator",
      "Systems Administrator",
      "Desktop Support",
    ],
  },
  {
    code: "0611",
    branches: ["Marine Corps"],
    militaryTitle: "Tactical Communications Operator",
    civilianTitles: [
      "Network Technician",
      "Telecommunications Technician",
      "IT Support Specialist",
      "Field Service Technician",
    ],
  },

  // --- Medical ----------------------------------------------------------
  {
    code: "68W",
    branches: ["Army"],
    militaryTitle: "Combat Medic Specialist",
    civilianTitles: [
      "Emergency Medical Technician",
      "Paramedic",
      "Medical Assistant",
      "Patient Care Technician",
      "Surgical Technologist",
    ],
  },
  {
    code: "HM",
    branches: ["Navy"],
    militaryTitle: "Hospital Corpsman",
    civilianTitles: [
      "Emergency Medical Technician",
      "Medical Assistant",
      "Patient Care Technician",
      "Licensed Practical Nurse",
    ],
  },

  // --- Supply and logistics ---------------------------------------------
  {
    code: "92Y",
    branches: ["Army"],
    militaryTitle: "Unit Supply Specialist",
    civilianTitles: [
      "Warehouse Supervisor",
      "Inventory Specialist",
      "Supply Chain Coordinator",
      "Logistics Coordinator",
      "Materials Handler",
    ],
  },

  // --- Aviation maintenance ---------------------------------------------
  {
    code: "15T",
    branches: ["Army"],
    militaryTitle: "UH-60 Helicopter Repairer",
    civilianTitles: [
      "Aircraft Mechanic",
      "Aviation Maintenance Technician",
      "Airframe and Powerplant Mechanic",
      "Helicopter Mechanic",
    ],
  },
  {
    code: "6112",
    branches: ["Marine Corps"],
    militaryTitle: "Helicopter Mechanic",
    civilianTitles: [
      "Aircraft Mechanic",
      "Aviation Maintenance Technician",
      "Airframe and Powerplant Mechanic",
    ],
  },

  // --- Military police --------------------------------------------------
  {
    code: "31B",
    branches: ["Army"],
    militaryTitle: "Military Police",
    civilianTitles: [
      "Police Officer",
      "Security Manager",
      "Correctional Officer",
      "Loss Prevention Specialist",
      "Investigator",
    ],
  },
  {
    code: "MA",
    branches: ["Navy"],
    militaryTitle: "Master-at-Arms",
    civilianTitles: [
      "Police Officer",
      "Security Manager",
      "Correctional Officer",
      "Loss Prevention Specialist",
    ],
  },
  {
    code: "3P0X1",
    branches: ["Air Force"],
    militaryTitle: "Security Forces",
    civilianTitles: ["Police Officer", "Security Manager", "Correctional Officer"],
  },

  // --- Engineering ------------------------------------------------------
  {
    code: "12B",
    branches: ["Army"],
    militaryTitle: "Combat Engineer",
    civilianTitles: [
      "Construction Supervisor",
      "Heavy Equipment Operator",
      "Field Service Technician",
      "Project Coordinator",
    ],
  },

  // --- Intelligence -----------------------------------------------------
  {
    code: "35F",
    branches: ["Army"],
    militaryTitle: "Intelligence Analyst",
    civilianTitles: [
      "Intelligence Analyst",
      "Data Analyst",
      "Security Analyst",
      "Research Analyst",
      "Operations Analyst",
    ],
  },
];

/**
 * The generated long tail, from O*NET's Military Crosswalk (CC BY 4.0). 7,178
 * codes against the 17 written by hand here, which is the difference between
 * an app that understands a handful of common jobs and one that has something
 * to say to most people who install it.
 *
 * See scripts/build-crosswalk.ts for how it is produced, and in particular for
 * why O*NET-SOC 55-* is thrown away: that is the "Military Specific" group,
 * and 11B and 0311 map to nothing but `55-3016.00 Infantry`. Importing it
 * would have told the two largest combat MOSs to go and search job boards for
 * the word "Infantry".
 */
/**
 * The generated long tail: 7,178 codes against the 17 written by hand, which
 * is the difference between an app that understands a handful of common jobs
 * and one that has something to say to most people who install it.
 *
 * Built on first use, not at import. The packed form is one string literal, so
 * a test file that never looks up a code pays nothing to load it.
 *
 * See scripts/build-crosswalk.ts for why O*NET-SOC 55-* is thrown away: that
 * is the "Military Specific" group, and 11B and 0311 map to nothing but
 * 55-3016.00 Infantry. Importing it would have told the two largest combat
 * MOSs to search job boards for the word "Infantry".
 */
let generatedTable: Map<string, readonly string[]> | null = null;

function generatedTitlesFor(code: string): readonly string[] {
  if (generatedTable === null) {
    generatedTable = new Map();
    const { titles: titleBlob, packed } = crosswalkData as {
      readonly titles: string;
      readonly packed: string;
    };
    const titles = titleBlob.split("\n");
    for (const line of packed.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const forCode = line
        .slice(tab + 1)
        .split(",")
        .map((index: string) => titles[Number(index)] ?? "")
        .filter((title: string) => title !== "");
      generatedTable.set(line.slice(0, tab), forCode);
    }
  }
  return generatedTable.get(code) ?? [];
}

/**
 * Hand-written entries win outright.
 *
 * They were chosen against what a veteran actually types into a job search,
 * and they beat the generated ones head to head: O*NET calls 88M "Heavy and
 * Tractor-Trailer Truck Drivers"; the entry above says "Truck Driver", "CDL
 * Driver", "Delivery Driver". More coverage is worth having, but not at the
 * cost of a considered answer.
 */
const BY_CODE: ReadonlyMap<string, CrosswalkEntry> = new Map(
  CROSSWALK.map((entry) => [entry.code.toUpperCase(), entry]),
);

export function civilianTitlesFor(code: string): readonly string[] {
  const key = code.trim().toUpperCase();
  return BY_CODE.get(key)?.civilianTitles ?? generatedTitlesFor(key);
}
