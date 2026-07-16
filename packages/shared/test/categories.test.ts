import { describe, expect, it } from 'vitest';
import { bucketFor, categorizeActivity, isRealtimeCall } from '../src/categories';
import { stripMailChrome } from '../src/text';

describe('stripMailChrome — webmail tabs', () => {
  it('strips the unread counter + Inbox/browser chrome from web-Missive tabs', () => {
    expect(stripMailChrome('(18) Work Status Update - 7/13/2026 - Inbox - Google Chrome')).toBe(
      'Work Status Update - 7/13/2026',
    );
    expect(stripMailChrome('(5) Nelson Tax prep follow up - Inbox - Google Chrome')).toBe('Nelson Tax prep follow up');
    // desktop titles (no counter) unchanged in meaning
    expect(stripMailChrome('Nelson Tax prep follow up - Inbox')).toBe('Nelson Tax prep follow up');
    // a subject that itself starts with a parenthesized year is NOT eaten beyond the counter
    expect(stripMailChrome('(2) (2024) K-1 question - Inbox')).toBe('(2024) K-1 question');
    // 4-digit "(2024)" is a year, not an unread counter — untouched
    expect(stripMailChrome('(2024) K-1 question - Inbox')).toBe('(2024) K-1 question');
  });
});

describe('isRealtimeCall', () => {
  it('flags a native call app (Krisp)', () => {
    expect(isRealtimeCall('krisp.exe', null, 'Krisp')).toBe(true);
  });

  it('flags a browser Google Meet by host', () => {
    expect(isRealtimeCall('chrome.exe', 'meet.google.com', 'Meet - Onboarding - Google Chrome')).toBe(true);
  });

  it('flags a Google Meet tab by title when the URL is missing', () => {
    expect(isRealtimeCall('chrome.exe', null, 'Meet - ApparelMagic Onboarding Call - Google Chrome')).toBe(true);
  });

  it('does not flag ordinary browsing or "meeting"-ish titles', () => {
    expect(isRealtimeCall('chrome.exe', 'docs.google.com', 'Budget - Google Sheets')).toBe(false);
    expect(isRealtimeCall('chrome.exe', null, 'Meeting notes - Google Docs')).toBe(false);
    expect(isRealtimeCall('EXCEL.EXE', null, 'Recon.xlsx - Excel')).toBe(false);
  });
});

describe('categorizeActivity — calls', () => {
  it('buckets an unattributed browser call as external_call', () => {
    const hit = categorizeActivity({ appNorm: 'chrome', host: 'meet.google.com', title: 'Meet - Onboarding - Google Chrome' });
    expect(hit?.key).toBe('external_call');
  });

  it('still buckets a native call app as external_call', () => {
    const hit = categorizeActivity({ appNorm: 'krisp', host: '', title: 'Krisp' });
    expect(hit?.key).toBe('external_call');
  });

  it('does not treat an ordinary spreadsheet as a call', () => {
    const hit = categorizeActivity({ appNorm: 'excel', host: '', title: 'Recon.xlsx - Excel' });
    expect(hit?.key).not.toBe('external_call');
  });
});

describe('categorizeActivity — firm overhead', () => {
  it('buckets cross-client Financial Cents pages as firm_admin', () => {
    for (const url of [
      'https://app.financial-cents.com/dashboard',
      'https://app.financial-cents.com/dashboard/1480799',
      'https://app.financial-cents.com/clients/client-tasks',
      'https://app.financial-cents.com/clients',
      'https://app.financial-cents.com/home?filter_view=',
      'https://app.financial-cents.com/reports/time',
      'https://app.financial-cents.com/inbox?integrations=',
    ]) {
      expect(categorizeActivity({ appNorm: 'chrome', host: 'app.financial-cents.com', title: 'Projects', url })?.key).toBe('firm_admin');
    }
  });

  it('does NOT bucket a specific client Financial Cents page (stays billable)', () => {
    expect(categorizeActivity({ appNorm: 'chrome', host: 'app.financial-cents.com', title: '1065 Tax Return', url: 'https://app.financial-cents.com/project/8036043?client_id=123' })).toBeNull();
    expect(categorizeActivity({ appNorm: 'chrome', host: 'app.financial-cents.com', title: 'Client', url: 'https://app.financial-cents.com/clients/999' })).toBeNull();
  });

  it('buckets firm planning spreadsheets and the Time Tracker as firm overhead', () => {
    expect(categorizeActivity({ appNorm: 'excel', title: 'Master Client List - Excel' })?.key).toBe('firm_admin');
    expect(categorizeActivity({ appNorm: 'excel', title: 'Project List Jul 13 2026 - Excel' })?.key).toBe('firm_admin');
    expect(categorizeActivity({ appNorm: 'chrome', host: 'time.ashfordsky.com', title: 'Ashford Sky — Time Tracker', url: 'https://time.ashfordsky.com/day/2026-07-13' })?.key).toBe('firm_tooling');
  });

  // Regression: Gusto/Bill.com/etc. are 'firm', not 'hard', so a payroll/AP run
  // ON BEHALF OF a client (client named in the title) bills to that client, while
  // the firm's own books still fall to firm overhead. Previously the 'hard' tier
  // pre-empted the client match and logged client payroll as non-billable.
  it('flags payroll/AP platforms as firm tier (yields to a client), not hard', () => {
    const gusto = categorizeActivity({
      appNorm: 'chrome',
      host: 'app.gusto.com',
      title: 'Inputs | Pay | Acme Holdings LLC | Gusto - Google Chrome',
      url: 'https://app.gusto.com/acme-holdings-llc/payroll_admin/pay',
    });
    expect(gusto?.key).toBe('firm_admin');
    expect(gusto?.tier).toBe('firm'); // NOT 'hard'
  });
});

describe('categorizeActivity — obvious non-billable that used to land in "unresolved"', () => {
  it('buckets a Pandora player title as music even without the URL', () => {
    const hit = categorizeActivity({ appNorm: 'msedge', host: '', title: 'Chris Stapleton Radio - Now Playing on Pandora - Work - Microsoft Edge' });
    expect(hit?.key).toBe('music');
  });

  it('buckets a Discord game tab as social', () => {
    const hit = categorizeActivity({ appNorm: 'chrome', host: '', title: '(1) Discord | "Cards" | AsyncTI4 (Fighter Club) - Google Chrome' });
    expect(hit?.key).toBe('social_media');
  });

  it('buckets web Missive (browser host) as internal email', () => {
    const hit = categorizeActivity({ appNorm: 'chrome', host: 'mail.missiveapp.com', title: '(3) June Close Out Questions - Inbox - Google Chrome' });
    expect(hit?.key).toBe('email_admin');
  });

  it('buckets the firm notes app as firm tooling', () => {
    const hit = categorizeActivity({ appNorm: 'chrome', host: 'notes.ashfordsky.com', title: 'Notes' });
    expect(hit?.key).toBe('firm_tooling');
  });

  it('buckets cross-client Review Tracker navigation as firm tooling', () => {
    for (const url of [
      'https://notes.ashfordsky.com/',
      'https://notes.ashfordsky.com/dashboard',
      'https://notes.ashfordsky.com/projects',
      'https://notes.ashfordsky.com/clients',
      'https://notes.ashfordsky.com/feedback',
    ]) {
      const hit = categorizeActivity({ appNorm: 'chrome', host: 'notes.ashfordsky.com', title: 'Review Tracker', url });
      expect(hit?.key).toBe('firm_tooling');
      expect(hit?.tier).toBe('firm'); // yields to a real client signal
    }
  });

  it('does NOT bucket a Review Tracker project page (it is that client’s work)', () => {
    expect(
      categorizeActivity({
        appNorm: 'chrome',
        host: 'notes.ashfordsky.com',
        title: 'Review Note Tracker',
        url: 'https://notes.ashfordsky.com/projects/503',
      }),
    ).toBeNull();
  });

  it('does NOT force real client work into a bucket (stays for the resolvers)', () => {
    // QuickBooks / a blank-title spreadsheet are billable client work with no
    // non-billable signal — categorize must return null so it is NOT mislabeled
    // non-billable (it attributes via the QBO/mapping resolvers, or stays unknown).
    expect(categorizeActivity({ appNorm: 'chrome', host: 'qbo.intuit.com', title: 'Balance Sheet - Google Chrome' })).toBeNull();
    expect(categorizeActivity({ appNorm: 'excel', host: '', title: '' })).toBeNull();
  });
});

describe('bucketFor — a client signal wins over a firm-tier platform', () => {
  const gusto = { key: 'firm_admin', label: 'Firm admin', tier: 'firm' as const };

  it('bills a client-named Gusto page to that client (title match, conf 0.72)', () => {
    // A direct client match (window_title_name at 0.72 ≥ reviewThreshold 0.5)
    // beats the firm-tier bucket → null means "not non-billable; keep the client".
    const outcome = { clientId: 'acme', resolverType: 'window_title_name', confidence: 0.72 };
    expect(bucketFor(outcome, gusto, 0.5)).toBeNull();
  });

  it('keeps the firm’s own payroll (no client) as firm overhead', () => {
    const outcome = { clientId: null, resolverType: null, confidence: 0 };
    expect(bucketFor(outcome, gusto, 0.5)).toBe('firm_admin');
  });

  it('does not let mere carry-forward on Gusto override the firm bucket', () => {
    // carry-forward is not a "direct" client, so firm-tier wins — a client you
    // were just on won't silently bill for firm payroll admin.
    const outcome = { clientId: 'prev', resolverType: 'context_carry_forward', confidence: 0.9 };
    expect(bucketFor(outcome, gusto, 0.5)).toBe('firm_admin');
  });
});
