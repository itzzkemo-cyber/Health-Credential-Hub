type CredentialType =
  | "BLS"
  | "ACLS"
  | "PALS"
  | "NRP"
  | "TNCC"
  | "TCRN"
  | "SCFHS_license"
  | "SCFHS_classification"
  | "infection_control"
  | "fire_safety"
  | "malpractice_insurance"
  | "custom";

export interface LocalPdfCredentialExtraction {
  detectedType: CredentialType;
  holderName: string | null;
  holderNameAr: string | null;
  issuerName: string | null;
  issuerNameAr: string | null;
  certificateNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  confidence: {
    overall: number;
    type: number;
    name: number;
    issuer: number;
    certNumber: number;
    issueDate: number;
    expiryDate: number;
  };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function bounded(value: string | undefined, max = 160): string | null {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, max) : null;
}

function validIsoDate(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1900 ||
    year > 2200
  )
    return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  )
    return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeExtractedPdfDate(value: string): string | null {
  const input = value.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(input);
  if (match)
    return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(input);
  if (match)
    return validIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(input);
  if (match)
    return validIsoDate(
      Number(match[3]),
      MONTHS[match[2].toLowerCase()] ?? 0,
      Number(match[1]),
    );
  match = /^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/.exec(input);
  return match
    ? validIsoDate(
        Number(match[3]),
        MONTHS[match[1].toLowerCase()] ?? 0,
        Number(match[2]),
      )
    : null;
}

const DATE_VALUE =
  "(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})";

function labeledDate(text: string, labels: string[]): string | null {
  const match = new RegExp(
    `(?:${labels.join("|")})\\s*[:#-]?\\s*${DATE_VALUE}`,
    "i",
  ).exec(text);
  return match?.[1] ? normalizeExtractedPdfDate(match[1]) : null;
}

function detectType(text: string): CredentialType {
  const candidates: Array<[CredentialType, RegExp]> = [
    ["ACLS", /\b(?:ACLS|advanced cardiovascular life support)\b/i],
    ["PALS", /\b(?:PALS|pediatric advanced life support)\b/i],
    ["BLS", /\b(?:BLS|basic life support)\b/i],
    ["NRP", /\b(?:NRP|neonatal resuscitation program)\b/i],
    ["TNCC", /\b(?:TNCC|trauma nursing core course)\b/i],
    ["TCRN", /\bTCRN\b/i],
    ["SCFHS_license", /(?:SCFHS|Saudi Commission for Health Specialties).{0,40}\blicen[cs]e\b/i],
    ["SCFHS_classification", /(?:SCFHS|Saudi Commission for Health Specialties).{0,40}\bclassification\b/i],
    ["infection_control", /\binfection control\b/i],
    ["fire_safety", /\bfire safety\b/i],
    ["malpractice_insurance", /\b(?:malpractice|professional indemnity)\b/i],
  ];
  return candidates.find(([, pattern]) => pattern.test(text))?.[0] ?? "custom";
}

function knownIssuer(text: string): { en: string; ar: string | null } | null {
  const known: Array<[RegExp, string, string | null]> = [
    [/Saudi Heart Association/i, "Saudi Heart Association", "الجمعية السعودية للقلب"],
    [/American Heart Association/i, "American Heart Association", "جمعية القلب الأمريكية"],
    [/Saudi Commission for Health Specialties|SCFHS/i, "Saudi Commission for Health Specialties", "الهيئة السعودية للتخصصات الصحية"],
  ];
  const match = known.find(([pattern]) => pattern.test(text));
  return match ? { en: match[1], ar: match[2] } : null;
}

/**
 * Convert bounded text from the isolated PDF worker into review-only
 * suggestions. Values are deliberately conservative: the employee must still
 * review and apply them, and no suggestion verifies a credential.
 */
export function extractLocalPdfCredentialSuggestions(
  sourceText: string,
): LocalPdfCredentialExtraction | null {
  const text = sourceText
    .slice(0, 24 * 1024)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 8) return null;

  const type = detectType(text);
  const issuer = knownIssuer(text);
  const certificateNumber = bounded(
    /(?:certificate|certification|ecard|card|license|licence)\s*(?:(?:number|no\.?|id|code)\s*[:#-]?|[:#-])\s*([A-Z0-9][A-Z0-9/-]{3,39})/i.exec(
      text,
    )?.[1],
    40,
  );
  const holderName = bounded(
    /(?:this certifies that|issued to|participant|student|holder|name)\s*[:#-]?\s*([A-Z][A-Za-z' -]{2,79}?)(?=\s+(?:has|successfully|completed|course|certificate|issued|issue|valid|date|$))/i.exec(
      text,
    )?.[1],
    80,
  );
  const holderNameAr = bounded(
    /(?:الاسم|اسم المتدرب|صاحب الشهادة)\s*[:#-]?\s*([\u0600-\u06ff][\u0600-\u06ff 'ـ-]{2,79})/i.exec(
      text,
    )?.[1],
    80,
  );
  const issueDate = labeledDate(text, [
    "issue(?:d)?(?: date)?",
    "date of issue",
    "date issued",
    "تاريخ الإصدار",
  ]);
  const expiryDate = labeledDate(text, [
    "expir(?:y|es|ation)(?: date)?",
    "expiration date",
    "valid (?:until|through)",
    "تاريخ الانتهاء",
  ]);

  const meaningful = [
    type === "custom" ? null : type,
    issuer?.en,
    certificateNumber,
    holderName,
    holderNameAr,
    issueDate,
    expiryDate,
  ].filter(Boolean).length;
  if (meaningful === 0) return null;

  const confidence = {
    overall: Math.min(0.78, 0.35 + meaningful * 0.06),
    type: type === "custom" ? 0 : 0.82,
    name: holderName || holderNameAr ? 0.62 : 0,
    issuer: issuer ? 0.84 : 0,
    certNumber: certificateNumber ? 0.72 : 0,
    issueDate: issueDate ? 0.78 : 0,
    expiryDate: expiryDate ? 0.78 : 0,
  };
  return {
    detectedType: type,
    holderName,
    holderNameAr,
    issuerName: issuer?.en ?? null,
    issuerNameAr: issuer?.ar ?? null,
    certificateNumber,
    issueDate,
    expiryDate,
    confidence,
  };
}
