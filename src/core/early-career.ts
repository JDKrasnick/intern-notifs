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
 * Title-led lifecycle signal. The catalog covers early-career hiring, so a
 * graduate or entry-level programme counts alongside an internship, co-op, or
 * apprenticeship. Boards post plurals ("AI Internships"), so plurals match too;
 * "internal" and "international" still fail the word boundary, and bare
 * "graduate" is excluded because it far more often marks a degree requirement
 * than a new-graduate role.
 */
export const lifecycleTitlePattern = new RegExp([
  String.raw`\b(?:interns?(?:hips?)?|co[ -]?ops?|cooperative education|apprentices?(?:hips?)?)\b`,
  String.raw`\bnew ?grad(?:uate)?s?\b`,
  String.raw`\b(?:university|campus|college)[ -](?:graduate|hire|programme?|program)\b`,
  String.raw`\bgraduate[ -](?:programme?|program|scheme|rotation(?:al)?|analyst|engineer\w*|developer|trainee|role|opportunit\w+)\b`,
  String.raw`\b(?:early[ -]career|entry[ -]level|working student|placement (?:year|student|programme?)|year in industry)\b`,
].join('|'), 'i');

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

/**
 * A bare year is only a hiring season when it is plausibly one: descriptions
 * mention founding years and copyright dates, and a stray "2010" would otherwise
 * become part of the role's identity.
 */
export function inferSeason(title: string, description: string, now = new Date()): string {
  const text = `${title} ${description}`;
  const season = text.match(/\b(summer|fall|spring|winter)\s*(?:intern(?:ship)?\s*)?(20\d{2})\b/i);
  if (season) return `${season[1].toLowerCase()}-${season[2]}`;
  const currentYear = now.getUTCFullYear();
  for (const match of text.matchAll(/\b(20\d{2})\b/g)) {
    const year = Number(match[1]);
    if (year >= currentYear && year <= currentYear + 3) return match[1]!;
  }
  return 'ongoing';
}

export function inferWorkMode(value: string | undefined): RawListing['workMode'] | undefined {
  if (!value) return undefined;
  if (/remote/i.test(value)) return 'remote';
  if (/hybrid/i.test(value)) return 'hybrid';
  if (/on.?site|in.?person/i.test(value)) return 'onsite';
  return undefined;
}
