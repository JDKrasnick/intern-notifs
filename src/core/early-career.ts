import type { JobRequirements, RawListing } from '../types.js';

const entities: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
};

/** Decodes the small set of HTML entities ATS descriptions use, then strips markup. */
export function htmlToText(value: string | undefined): string {
  const decoded = (value ?? '').replace(/&(?:nbsp|amp|lt|gt|quot|#39|#x27|apos);/gi, (match) => entities[match.toLowerCase()] ?? match);
  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Title-led lifecycle signal: an internship, co-op, or apprenticeship must be
 * named in the title. Boards post plurals ("AI Internships"), so the plural is
 * matched too; "internal" and "international" still fail the word boundary.
 */
export const lifecycleTitlePattern = /\b(?:interns?(?:hips?)?|co[ -]?ops?|cooperative education|apprentices?(?:hips?)?)\b/i;

export function hasLifecycleTitleSignal(title: string): boolean {
  return lifecycleTitlePattern.test(title);
}

const usCitizen = '(?:u\\.?s\\.?|united states)\\s+citizens?';
const degree = "(?:advanced degree|master'?s|ph\\.?d\\.?|doctorate|mba)";
const citizenshipPattern = new RegExp(`(?:\\b(?:must|requires?|requirement|eligible only|only)\\b[^.]{0,120}${usCitizen}|${usCitizen}[^.]{0,80}\\b(?:required|only|must)\\b)`, 'i');
const advancedDegreePattern = new RegExp(`(?:\\b(?:must|requires?|requirement|eligible only)\\b[^.]{0,120}${degree}|${degree}[^.]{0,80}\\b(?:required|must)\\b)`, 'i');

/** Conservative, source-declared citizenship/degree signals from decoded description text. */
export function earlyCareerRequirements(content: string): JobRequirements {
  return {
    requiresUsCitizenship: citizenshipPattern.test(content),
    advancedDegreeRequired: advancedDegreePattern.test(content),
  };
}

export function inferSeason(title: string, description: string): string {
  const text = `${title} ${description}`;
  const season = text.match(/\b(summer|fall|spring|winter)\s*(?:intern(?:ship)?\s*)?(20\d{2})\b/i);
  if (season) return `${season[1].toLowerCase()}-${season[2]}`;
  const year = text.match(/\b(20\d{2})\b/);
  return year ? year[1] : 'ongoing';
}

export function inferWorkMode(value: string | undefined): RawListing['workMode'] | undefined {
  if (!value) return undefined;
  if (/remote/i.test(value)) return 'remote';
  if (/hybrid/i.test(value)) return 'hybrid';
  if (/on.?site|in.?person/i.test(value)) return 'onsite';
  return undefined;
}
