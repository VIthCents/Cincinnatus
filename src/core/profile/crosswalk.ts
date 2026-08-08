/**
 * Military occupation code → civilian job titles.
 *
 * PROVENANCE. This is the hand-built fallback SPEC section 6 explicitly allows
 * for Phase 1 ("commit a hand-built sample covering common MOS families so the
 * pipeline works end-to-end, and log a TODO"). It is NOT the full O*NET
 * crosswalk.
 *
 * TODO(crosswalk): replace with output from scripts/build-crosswalk.ts, which
 * transforms O*NET's Military Crosswalk (milx*.csv: SVC branch column, MOC
 * code, and up to four parallel O*NET-SOC slots per row) into a vendored
 * crosswalk.json. O*NET data is CC BY 4.0 and requires attribution when shipped.
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

const BY_CODE: ReadonlyMap<string, CrosswalkEntry> = new Map(
  CROSSWALK.map((entry) => [entry.code.toUpperCase(), entry]),
);

/**
 * Civilian titles for a military code, or an empty array if we do not know it.
 *
 * Returning nothing is correct for an unknown code — inventing plausible titles
 * would put words in the veteran's mouth that their record does not support.
 */
export function civilianTitlesFor(code: string): readonly string[] {
  return BY_CODE.get(code.trim().toUpperCase())?.civilianTitles ?? [];
}

export function crosswalkEntryFor(code: string): CrosswalkEntry | null {
  return BY_CODE.get(code.trim().toUpperCase()) ?? null;
}
