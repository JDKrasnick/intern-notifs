import { describe, expect, it } from 'vitest';
import { matchRecentClickedGmailApplication, type GmailMetadata } from '../src/gmail-matcher.js';
import type { Internship } from '../src/types.js';

interface HistoricalCase {
  company: string;
  subject: string;
  sender: string;
  title?: string;
}

const receivedAt = '2026-08-25T12:00:00.000Z';

function role(example: HistoricalCase, index: number): Internship {
  return {
    jobId: `history-${index}`,
    company: example.company,
    title: example.title ?? 'Software Engineering Intern',
    location: 'United States',
    season: 'Summer 2027',
    applyUrl: `https://job-boards.greenhouse.io/example/jobs/${index}`,
    normalizedUrl: `https://job-boards.greenhouse.io/example/jobs/${index}`,
    fingerprint: `history-${index}`,
    technical: true,
    open: true,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: receivedAt,
    compensation: { raw: 'Not listed' },
    sourceReferences: [],
    notification: { smsPending: false, digestPending: false },
    postingIdentity: {
      provider: example.sender.includes('ashbyhq') ? 'ashby'
        : example.sender.includes('myworkday') ? 'workday'
          : example.sender.includes('careers.tiktok') ? 'bytedance' : 'greenhouse',
      canonicalApplicationUrl: `https://job-boards.greenhouse.io/example/jobs/${index}`,
      canonicalJobId: `history-${index}`,
      aliases: [],
    },
  } as Internship;
}

function message(example: HistoricalCase, at = receivedAt): GmailMetadata {
  return { subject: example.subject, sender: example.sender, receivedAt: at, labels: ['INBOX'] };
}

function clicked(example: HistoricalCase, index: number) {
  return { job: role(example, index), clickedAt: '2026-08-25T11:55:00.000Z', expiresAt: '2026-08-26T12:55:00.000Z' };
}

// Sanitized header patterns sampled from the connected Gmail account. These
// preserve the historical metadata-only regression corpus alongside content tests.
const confirmations: HistoricalCase[] = [
  { company: 'SpaceX', subject: 'Thank you for applying to SpaceX', sender: 'SpaceX <no-reply-recruiting@spacex.com>', title: 'Summer 2027 Software Engineering Internship/Co-op' },
  { company: 'Zipline', subject: 'Thank you for applying to Zipline', sender: 'Zipline <no-reply@flyzipline.com>' },
  { company: 'TikTok', subject: 'Thank you for applying to TikTok!', sender: 'TikTok <noreply@careers.tiktok.com>', title: 'Software Engineer Intern (TikTok AI Search & Visual Search Infra Team)' },
  { company: 'D. E. Shaw', subject: 'Your application to the D. E. Shaw group', sender: 'recruiting@deshaw.com' },
  { company: 'American Express', subject: 'Thank you for applying to Campus Undergraduate Summer Internship Program - 2027 Software Engineer', sender: 'Amex Careers <careers@recruitment.americanexpress.com>' },
  { company: 'Postman', subject: 'John, thanks for wanting to become a Postmanaut!', sender: 'Postman <notifications@greenhouse-mail.io>' },
  { company: 'IMC', subject: "We've got it! Your application for Software Engineer, Early Career at IMC is underway", sender: 'IMC Careers <careers@imc.com>', title: 'Software Engineer, Early Career' },
  { company: 'Five Rings', subject: 'Regarding the Summer Intern 2027 - Software Developer role at Five Rings', sender: 'Five Rings <notifications@greenhouse-mail.io>', title: 'Summer Intern 2027 - Software Developer' },
  { company: 'Garda Capital Partners', subject: 'Thank you for applying to Garda Capital Partners', sender: 'no-reply@us.greenhouse-mail.io', title: 'Software Engineer Intern' },
  { company: 'Garda Capital Partners', subject: 'Thank you for applying to Garda Capital Partners', sender: 'no-reply@us.greenhouse-mail.io', title: 'Data Engineer Intern' },
  { company: 'Garda Capital Partners', subject: 'Thank you for applying to Garda Capital Partners', sender: 'no-reply@us.greenhouse-mail.io', title: 'Quantitative Developer Intern' },
  { company: 'Exa', subject: 'Thanks for applying to Exa 🚀', sender: 'Exa Hiring Team <no-reply@ashbyhq.com>' },
  { company: 'Replit', subject: 'Thank you for your application to Replit', sender: 'Replit Hiring Team <no-reply@ashbyhq.com>' },
  { company: 'Notion', subject: 'Thank you for your application to Notion, John!', sender: "Notion's Recruiting Team <recruiting-no-reply@makenotion.com>" },
  { company: 'Roblox', subject: 'Thank you for applying to Roblox', sender: 'Roblox <no-reply@roblox.com>' },
  { company: 'TikTok', subject: 'Thank you for applying to TikTok!', sender: 'TikTok <noreply@careers.tiktok.com>', title: 'Software Engineer Intern (TikTok-Agentic Creation-Effect Platform)' },
  { company: 'Radix Trading', subject: 'Thank you for applying to Radix Trading', sender: 'Radix Trading <jobs@radix-trading.com>' },
  { company: 'Hudson River Trading', subject: 'Thank you for applying to Hudson River Trading', sender: 'Hudson River Trading <jobs@hudsonrivertrading.com>' },
  { company: 'Jane Street', subject: 'Thank you for applying to Jane Street', sender: 'Jane Street Recruiting <recruiting@janestreet.com>' },
  { company: 'Google', subject: 'Thank you for applying to Google', sender: 'Google Careers <jobs-noreply@google.com>' },
  { company: 'Sentry', subject: 'Thank you for applying to become a Sentaur!', sender: 'Sentry <no-reply@ashbyhq.com>' },
  { company: 'Adobe', subject: 'Thank you for applying to Adobe', sender: 'Adobe Careers <adobe@myworkday.com>' },
  { company: 'Moloco', subject: 'Thank you for applying to Moloco', sender: 'Moloco Recruiting <notifications@greenhouse-mail.io>' },
  { company: 'Mastercard', subject: 'Thank you for your application!', sender: 'MasterCard People Services <mastercard@myworkday.com>' },
  { company: 'Microsoft', subject: 'Thank you for your application!', sender: 'Microsoft Careers <donotreply@email.careers.microsoft.com>', title: 'AI Software Engineering Intern - Edge' },
  { company: 'Microsoft', subject: 'Thank you for your application!', sender: 'Microsoft Careers <donotreply@email.careers.microsoft.com>', title: 'AI Software Engineering Intern' },
  { company: 'NVIDIA', subject: 'Thank you for your interest in NVIDIA', sender: 'NVIDIA HR <nvidia@myworkday.com>', title: 'NVIDIA 2027 Internships: Software Engineering' },
  { company: 'IBM', subject: 'You have successfully submitted your IBM job application - Data and AI Intern 2027', sender: 'IBM Talent Acquisition <talent@ibm.com>', title: 'Data and AI Intern 2027' },
  { company: 'IBM', subject: 'You have successfully submitted your IBM job application - 2027 Software Engineering Intern – Agentic AI & Workflow Automation', sender: 'IBM Talent Acquisition <talent@ibm.com>', title: '2027 Software Engineering Intern – Agentic AI & Workflow Automation' },
];

const downstreamApplicationEvidence: HistoricalCase[] = [
  { company: 'TikTok', subject: "You're invited! Assessment for Software Engineer Intern", sender: 'TikTok <job@careers.tiktok.com>' },
  { company: 'Roblox', subject: '[Update] Your Roblox Job Application', sender: 'Roblox <no-reply@roblox.com>' },
  { company: 'Roblox', subject: 'You’ve completed the Roblox Assessments!', sender: 'Roblox Assessment <noreply@email.roblox.com>' },
  { company: 'TikTok', subject: 'Update on your TikTok application', sender: 'TikTok <noreply@careers.tiktok.com>' },
  { company: 'Intrinsic', subject: 'An update from Intrinsic on your application to Software Engineering Intern', sender: 'Intrinsic Careers <jobs@intrinsic.ai>' },
  { company: 'Delinea', subject: 'Update on your application to Delinea', sender: 'Delinea Recruiting <jobs@delinea.com>' },
  { company: 'Perchwell', subject: 'An update regarding your application to Perchwell', sender: 'Perchwell <jobs@perchwell.com>' },
  { company: 'Vetty', subject: 'Background screening for your application', sender: 'Vetty <support@vetty.co>' },
  { company: 'IBM', subject: 'Your IBM Application: Next Steps', sender: 'IBM Talent Acquisition <talent@ibm.com>', title: 'Data and AI Intern 2027' },
  { company: 'IBM', subject: 'Your IBM Application: Next Steps', sender: 'IBM Talent Acquisition <talent@ibm.com>', title: '2027 Software Engineering Intern – Agentic AI & Workflow Automation' },
];

const nonConfirmations: HistoricalCase[] = [
  { company: 'American Express', subject: 'Please verify your identity for Software Engineer Internship position', sender: 'Amex Careers <careers@recruitment.americanexpress.com>' },
  { company: 'Microsoft', subject: 'You have incomplete applications', sender: 'Microsoft Careers <donotreply@email.careers.microsoft.com>' },
  { company: 'WayUp', subject: 'Your application is almost complete', sender: 'WayUp <jobs@wayup.com>' },
  { company: 'Battle.net', subject: 'The Witcher 3: Wild Hunt — Remastered is coming to Battle.net!', sender: 'Battle.net <noreply@e.battle.net>' },
];

describe('historical Gmail header replay', () => {
  it.each(confirmations.map((example, index) => [example.company, example, index] as const))(
    'marks a recent %s receipt as applied', (_company, example, index) => {
      expect(matchRecentClickedGmailApplication(message(example), [clicked(example, index)])).toMatchObject({ outcome: 'applied' });
    },
  );

  it.each(nonConfirmations.map((example, index) => [example.company, example, index] as const))(
    'does not mark a recent %s non-receipt as applied', (_company, example, index) => {
      expect(matchRecentClickedGmailApplication(message(example), [clicked(example, index)])).not.toMatchObject({ outcome: 'applied' });
    },
  );

  it.each(downstreamApplicationEvidence.map((example, index) => [example.company, example, index] as const))(
    'marks a recent %s downstream stage as proof of application', (_company, example, index) => {
      expect(matchRecentClickedGmailApplication(message(example), [clicked(example, index)])).toMatchObject({ outcome: 'applied' });
    },
  );

  it('does not mark a receipt-like Jane Street rejection delivered five days after Apply', () => {
    const example = confirmations.find(({ company }) => company === 'Jane Street')!;
    const result = matchRecentClickedGmailApplication(
      message(example, '2026-07-29T12:00:00.000Z'),
      [{ job: role(example, 99), clickedAt: '2026-07-24T11:55:00.000Z', expiresAt: '2026-07-25T12:55:00.000Z' }],
    );
    expect(result.outcome).toBe('ignore');
  });

  it('holds three contemporaneous Garda clicks for review instead of guessing', () => {
    const garda = confirmations.filter(({ company }) => company === 'Garda Capital Partners');
    const result = matchRecentClickedGmailApplication(message(garda[0]!), garda.map(clicked));
    expect(result.outcome).toBe('review');
  });
});
