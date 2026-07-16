import { describe, expect, it } from 'vitest';
import { type AttributionRule, bucketFor, categorizeActivity } from '@tt/shared';
import { runResolvers } from '../src/registry';
import { ContextEngine } from '../src/context';
import { correctionToRuleSpec } from '../src/corrections';
import { addClient, addDomain, addEmail, addName, ctx, emptyGraph, interval } from './helpers';

describe('email resolver', () => {
  it('attributes an exact email address (auto-finalize)', () => {
    const g = emptyGraph();
    addClient(g, 'c1', 'Widget Co LLC');
    addEmail(g, 'morgan@widgetco.example', 'c1');
    const { resolution, winner } = runResolvers(
      interval({ app: 'Missive', windowTitle: 'Re: Invoice — morgan@widgetco.example' }),
      ctx(g),
    );
    expect(winner?.resolverType).toBe('email_address');
    expect(resolution.clientId).toBe('c1');
    expect(resolution.status).toBe('auto_finalized');
  });

  it('attributes by domain when no exact address is mapped', () => {
    const g = emptyGraph();
    addClient(g, 'c2', 'Bright Kids Co');
    addDomain(g, 'brightkidsco.example', 'c2');
    const { resolution } = runResolvers(
      interval({ app: 'Missive', windowTitle: 'Thread with robin@brightkidsco.example' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('c2');
    expect(resolution.resolverType).toBe('email_domain');
  });

  it('flags review when a domain maps to multiple clients', () => {
    const g = emptyGraph();
    addClient(g, 'a', 'Alpha');
    addClient(g, 'b', 'Beta');
    addDomain(g, 'shared.com', 'a');
    addDomain(g, 'shared.com', 'b');
    const { resolution } = runResolvers(
      interval({ app: 'Missive', windowTitle: 'note to ap@shared.com' }),
      ctx(g),
    );
    expect(resolution.status).toBe('needs_review');
    expect(resolution.needsReview).toBe(true);
  });

  it('never attributes the firm’s own internal domain', () => {
    const g = emptyGraph();
    addClient(g, 'c1', 'Widget Co');
    const { resolution } = runResolvers(
      interval({ app: 'Missive', windowTitle: 'internal note darin@ashfordsky.com' }),
      ctx(g),
    );
    expect(resolution.clientId).toBeNull();
    expect(resolution.status).toBe('unresolved');
  });
});

describe('calendar resolver', () => {
  it('attributes an interval during a client meeting (authoritative)', () => {
    const g = emptyGraph();
    addClient(g, 'tl', 'Lantern Labs LLC');
    g.calendarEvents.push({
      startMs: Date.parse('2026-06-23T21:30:00Z'),
      endMs: Date.parse('2026-06-23T22:00:00Z'),
      clientId: 'tl',
      subject: 'Lantern Labs - May financials',
      confidence: 0.92,
    });
    const { resolution } = runResolvers(
      interval({ app: 'ms-teams.exe', windowTitle: 'Meeting', startTs: '2026-06-23T21:40:00Z', endTs: '2026-06-23T21:45:00Z' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('tl');
    expect(resolution.resolverType).toBe('calendar_event');
    expect(resolution.status).toBe('auto_finalized');
  });

  it('only attributes a meeting to people who were in it (host ↔ email gate)', () => {
    const g = emptyGraph();
    addClient(g, 'tl', 'Lantern Labs LLC');
    g.calendarEvents.push({
      startMs: Date.parse('2026-06-23T21:30:00Z'),
      endMs: Date.parse('2026-06-23T22:00:00Z'),
      clientId: 'tl',
      subject: 'Lantern Labs - May financials',
      confidence: 0.92,
      participants: ['darin@ashfordsky.com', 'avery@lanternlabs.example'],
    });
    // Alex was NOT in the meeting: his overlapping call must not inherit it.
    const alex = runResolvers(
      interval({ app: 'Zoom.exe', windowTitle: 'Zoom Meeting', hostname: 'alex', startTs: '2026-06-23T21:40:00Z', endTs: '2026-06-23T21:45:00Z' }),
      ctx(g),
    );
    expect(alex.resolution.resolverType).not.toBe('calendar_event');
    // Darin WAS in it: attributes as before.
    const darin = runResolvers(
      interval({ app: 'ms-teams.exe', windowTitle: 'Meeting', hostname: 'darin', startTs: '2026-06-23T21:40:00Z', endTs: '2026-06-23T21:45:00Z' }),
      ctx(g),
    );
    expect(darin.resolution.clientId).toBe('tl');
    expect(darin.resolution.resolverType).toBe('calendar_event');
  });

  it('does not attribute an interval outside any meeting window', () => {
    const g = emptyGraph();
    addClient(g, 'tl', 'Lantern Labs LLC');
    g.calendarEvents.push({
      startMs: Date.parse('2026-06-23T21:30:00Z'),
      endMs: Date.parse('2026-06-23T22:00:00Z'),
      clientId: 'tl',
      subject: 'Lantern Labs',
      confidence: 0.92,
    });
    const { resolution } = runResolvers(
      interval({ app: 'chrome.exe', windowTitle: 'YouTube', startTs: '2026-06-23T18:00:00Z', endTs: '2026-06-23T18:05:00Z' }),
      ctx(g),
    );
    expect(resolution.resolverType).not.toBe('calendar_event');
  });
});

describe('qbo resolver', () => {
  it('reads the company id from a switchCompany window title (host is accounts.intuit.com)', () => {
    const g = emptyGraph();
    addClient(g, 'lw', 'Ledger Works LLC');
    g.byQboRealm.set('1234567890123456', 'lw');
    const { resolution, winner } = runResolvers(
      interval({
        app: 'chrome.exe',
        windowTitle: 'qbo.intuit.com/app/switchCompany?companyId=1234567890123456 - Google Chrome',
        url: 'https://accounts.intuit.com/app/sign-in?app_group=QBO&iux_redirect_reason=SELECT_QBO_REALM',
      }),
      ctx(g),
    );
    expect(winner?.resolverType).toBe('qbo');
    expect(resolution.clientId).toBe('lw');
  });

  it('does not attribute an unmapped realm', () => {
    const g = emptyGraph();
    addClient(g, 'lw', 'Ledger Works LLC');
    g.byQboRealm.set('1234567890123456', 'lw');
    const { resolution } = runResolvers(
      interval({ app: 'chrome.exe', windowTitle: 'qbo.intuit.com/app/switchCompany?companyId=999999999999 - Google Chrome' }),
      ctx(g),
    );
    expect(resolution.clientId).not.toBe('lw');
  });
});

describe("a client's own name beats another client's alias (no false ambiguity)", () => {
  it('attributes an Excel workbook to the named client, not needs_review', () => {
    const g = emptyGraph();
    // The roster sync scatters sibling entity-names across a group: a name that is
    // one client's real name also lands as an alias on unrelated siblings.
    addClient(g, 'mbs', 'Zephyr Wellness LLC');
    addName(g, 'mhc', 'Zephyr Wellness LLC', 'entity_name'); // alias on a sibling
    addName(g, 'rel', 'Zephyr Wellness LLC', 'entity_name'); // alias on another
    const { resolution } = runResolvers(
      interval({ app: 'EXCEL.EXE', windowTitle: '2025 Return Workbook - Zephyr Wellness - Excel' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('mbs'); // the client whose own name it is
    expect(resolution.needsReview).toBe(false); // not flagged ambiguous
    expect(resolution.status).toBe('suggested');
  });

  it('bills a Review Tracker project page to that project’s client', () => {
    const g = emptyGraph();
    addClient(g, 'aga', 'Nimbus Construction LLC');
    g.byReviewProject.set('503', 'aga');
    const { resolution } = runResolvers(
      interval({
        app: 'chrome.exe',
        windowTitle: 'Review Note Tracker - Google Chrome',
        url: 'https://notes.ashfordsky.com/projects/503',
      }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('aga');
    expect(resolution.resolverType).toBe('review_tracker');
    expect(resolution.status).toBe('auto_finalized');
  });

  it('matches a formal first name to a nickname client (William -> Bill)', () => {
    const g = emptyGraph();
    addClient(g, 'g', 'Bill and Rachel Thornbury');
    const { resolution } = runResolvers(
      interval({ app: 'EXCEL.EXE', windowTitle: '2025 Individual Income Summary - William and Rachel Thornbury - Excel' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('g');
  });

  it('still flags genuine ambiguity between two real client names', () => {
    const g = emptyGraph();
    addClient(g, 'a', 'Summit Partners LLC');
    addClient(g, 'b', 'Summit Partners Inc'); // two distinct real clients, same core name
    const { resolution } = runResolvers(
      interval({ app: 'EXCEL.EXE', windowTitle: 'Summit Partners 2025 - Excel' }),
      ctx(g),
    );
    expect(resolution.needsReview).toBe(true);
  });
});

describe('screenshot OCR resolver', () => {
  it('attributes by a sender domain read from the screenshot', () => {
    const g = emptyGraph();
    addClient(g, 'tk', 'Meridian Inc');
    addDomain(g, 'kernelworks.example', 'tk');
    const { resolution } = runResolvers(interval({ app: 'Missive.exe', windowTitle: 'Tax letter 2024' }), {
      ...ctx(g),
      ocrText: 'From: Sam Rivera <sam@kernelworks.example>\nSubject: Tax letter 2024',
    });
    expect(resolution.clientId).toBe('tk');
    expect(resolution.resolverType).toBe('screenshot_ocr');
  });

  it('ignores OCR text with no known client address', () => {
    const g = emptyGraph();
    addClient(g, 'tk', 'Meridian Inc');
    addDomain(g, 'kernelworks.example', 'tk');
    const { resolution } = runResolvers(interval({ app: 'Missive.exe', windowTitle: 'Welcome!' }), {
      ...ctx(g),
      ocrText: 'From: noreply@kick.co\nWelcome to Kick!',
    });
    expect(resolution.clientId).toBeNull();
  });
});

describe('activity categories (non-client buckets)', () => {
  it('buckets Spotify as music (hard, never client work)', () => {
    const hit = categorizeActivity({ appNorm: 'spotify exe' });
    expect(hit?.key).toBe('music');
    expect(hit?.tier).toBe('hard');
  });

  it('buckets entertainment and social hosts', () => {
    expect(categorizeActivity({ appNorm: 'chrome exe', host: 'youtube.com' })?.key).toBe('entertainment');
    expect(categorizeActivity({ appNorm: 'chrome exe', host: 'www.linkedin.com' })?.key).toBe('social_media');
  });

  it('treats Claude as a soft AI bucket', () => {
    expect(categorizeActivity({ appNorm: 'claude exe' })?.tier).toBe('soft');
  });

  it('buckets prospecting, firm_admin, and research hosts', () => {
    expect(categorizeActivity({ host: 'searchfunder.com' })?.key).toBe('prospecting');
    expect(categorizeActivity({ host: 'app.ramp.com' })?.key).toBe('firm_admin');
    expect(categorizeActivity({ host: 'www.irs.gov' })?.key).toBe('research');
  });

  it('defaults unmatched email-app time to internal email (no unresolved inbox)', () => {
    expect(categorizeActivity({ appNorm: 'missive exe' })?.key).toBe('email_admin');
    expect(categorizeActivity({ appNorm: 'olk exe' })?.key).toBe('email_admin');
    expect(categorizeActivity({ appNorm: 'chrome exe', host: 'mail.google.com' })?.key).toBe('email_admin');
  });

  it('flags a firm-internal staff meeting from the title', () => {
    const hit = categorizeActivity(
      { appNorm: 'ms-teams exe', title: 'Dana Brooks | Microsoft Teams' },
      { staffNameTokens: new Set(['dana']) },
    );
    expect(hit?.key).toBe('firm_internal');
  });

  it('bucketFor: hard pre-empts a carried client; soft yields to one; direct client beats firm', () => {
    const music = { key: 'music', label: 'Music', tier: 'hard' as const };
    const ai = { key: 'ai_assistant', label: 'AI', tier: 'soft' as const };
    const firm = { key: 'firm_internal', label: 'Firm', tier: 'firm' as const };
    const carried = { clientId: 'c1', resolverType: 'context_carry_forward', confidence: 0.6 };
    expect(bucketFor(carried, music, 0.5)).toBe('music');
    expect(bucketFor(carried, ai, 0.5)).toBeNull();
    expect(bucketFor({ clientId: null, resolverType: null, confidence: 0 }, ai, 0.5)).toBe('ai_assistant');
    expect(bucketFor({ clientId: 'c1', resolverType: 'window_title_name', confidence: 0.72 }, firm, 0.5)).toBeNull();
  });
});

describe('email subject resolver (Missive)', () => {
  it('lands a Missive subject on the firm-attributed client', () => {
    const g = emptyGraph();
    addClient(g, 'nim', 'Nimbus Technologies LLC');
    g.emailSubjects.set('nimbus tax', { clientId: 'nim', ambiguous: false });
    const { resolution } = runResolvers(
      interval({ app: 'Missive.exe', windowTitle: 'Re: Nimbus Tax - Inbox - Darin - Ashford' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('nim');
    expect(resolution.resolverType).toBe('email_subject');
    expect(resolution.status).toBe('auto_finalized');
  });

  it('strips Missive "My Tasks" chrome and still matches the subject', () => {
    const g = emptyGraph();
    addClient(g, 'bhm', 'Vantage Holding BV');
    g.emailSubjects.set('dutch tax topics fy24', { clientId: 'bhm', ambiguous: false });
    const { resolution } = runResolvers(
      interval({
        app: 'Missive.exe',
        windowTitle: 'Dutch tax topics FY24 - My Tasks - (Darin) - Ashford Sky CPA',
      }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('bhm');
    expect(resolution.resolverType).toBe('email_subject');
  });

  it('flags an ambiguous subject for review', () => {
    const g = emptyGraph();
    addClient(g, 'a', 'Client A');
    g.emailSubjects.set('monthly close', { clientId: 'a', ambiguous: true });
    const { resolution } = runResolvers(
      interval({ app: 'Missive.exe', windowTitle: 'Monthly Close - Inbox - Darin - Ashford' }),
      ctx(g),
    );
    expect(resolution.status).toBe('needs_review');
  });
});

describe('window-title name resolver (desktop apps)', () => {
  it('attributes a Missive subject by client name, stripping mail chrome', () => {
    const g = emptyGraph();
    addClient(g, 'sv', 'Harbor Ventures LLC');
    const { resolution } = runResolvers(
      interval({ app: 'Missive.exe', windowTitle: 'RE: Harbor Ventures LLC 2023 K-1 - Inbox - Darin - Ashford' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('sv');
    expect(resolution.resolverType).toBe('window_title_name');
    expect(resolution.status).toBe('suggested');
  });

  it('does not match a Slack workspace with no corresponding client', () => {
    const g = emptyGraph();
    addClient(g, 'sv', 'Harbor Ventures LLC');
    const { resolution } = runResolvers(
      interval({ app: 'Slack.exe', windowTitle: 'finance-team (Channel) - Ashford Sky - Slack' }),
      ctx(g),
    );
    expect(resolution.clientId).toBeNull();
  });

  it('attributes Slack to the client whose workspace it is (embedded engagement)', () => {
    const g = emptyGraph();
    addClient(g, 'bh', 'Meridian Inc');
    const { resolution } = runResolvers(
      interval({ app: 'Slack.exe', windowTitle: 'Alex Kim, Jordan Lee (DM) - Meridian - 1 new item - Slack' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('bh');
    expect(resolution.resolverType).toBe('window_title_name');
  });

  it('matches a Teams meeting name to a client (strips " | Microsoft Teams")', () => {
    const g = emptyGraph();
    addClient(g, 'tl', 'Lantern Labs LLC');
    const { resolution } = runResolvers(
      interval({ app: 'ms-teams.exe', windowTitle: 'Lantern Labs - May financials overview | Microsoft Teams' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('tl');
    expect(resolution.resolverType).toBe('window_title_name');
  });

  it('matches the embedded client named in the Missive account chrome (raw-title fallback)', () => {
    const g = emptyGraph();
    addClient(g, 'bh', 'Meridian Inc');
    const { resolution } = runResolvers(
      interval({ app: 'Missive.exe', windowTitle: 'Inbox - Ashford Sky - Meridian' }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('bh');
  });
});

describe('CCH Axcess resolver', () => {
  it('boosts a client-name match inside the tax app', () => {
    const g = emptyGraph();
    addClient(g, 'c5', 'Summit Tire');
    const { resolution, winner } = runResolvers(
      interval({ app: 'CCH Axcess', windowTitle: 'CCH Axcess Tax — Summit Tire LLC — 2024 1120' }),
      ctx(g),
    );
    expect(winner?.resolverType).toBe('cch_axcess');
    expect(resolution.clientId).toBe('c5');
    expect(resolution.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('Google Sheet id resolver', () => {
  it('matches a mapped sheet id from the URL', () => {
    const g = emptyGraph();
    addClient(g, 'c6', 'Clearwater Brands');
    g.bySheetId.set('ABCdef1234567890XYZlongid01', 'c6');
    const { resolution } = runResolvers(
      interval({
        app: 'Chrome',
        windowTitle: '2024 Recon - Google Sheets',
        url: 'https://docs.google.com/spreadsheets/d/ABCdef1234567890XYZlongid01/edit#gid=0',
      }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('c6');
    expect(resolution.resolverType).toBe('google_sheet_id');
    expect(resolution.status).toBe('auto_finalized');
  });
});

describe('SharePoint folder resolver', () => {
  it('matches activity under a mapped client folder URL', () => {
    const g = emptyGraph();
    addClient(g, 'c7', 'Ridgeline Construction');
    g.folders.push({
      externalId: null,
      path: 'https://ashfordsky.sharepoint.com/sites/ashfordsky/shared documents/clients/ridgeline construction',
      clientId: 'c7',
      sourceSystem: 'sharepoint',
    });
    const { resolution } = runResolvers(
      interval({
        app: 'Edge',
        windowTitle: 'Ridgeline Construction - 2024 - All Documents',
        url: 'https://ashfordsky.sharepoint.com/sites/AshfordSky/Shared%20Documents/Clients/Ridgeline%20Construction/2024',
      }),
      ctx(g),
    );
    expect(resolution.clientId).toBe('c7');
    expect(resolution.resolverType).toBe('sharepoint_folder');
  });
});

describe('rule overlay', () => {
  it('takes priority over built-in resolvers', () => {
    const g = emptyGraph();
    addClient(g, 'c8', 'Sheet Owner A');
    addClient(g, 'c9', 'Rule Owner B');
    g.bySheetId.set('SHEETID0000000000000000001', 'c8');
    const rules: AttributionRule[] = [
      {
        id: 'r1',
        ruleType: 'google_sheet_id',
        matchKind: 'exact',
        pattern: 'SHEETID0000000000000000001',
        normalized: 'SHEETID0000000000000000001',
        clientId: 'c9',
        confidence: 0.98,
        enabled: true,
        priority: 10,
      },
    ];
    const { resolution } = runResolvers(
      interval({ url: 'https://docs.google.com/spreadsheets/d/SHEETID0000000000000000001/edit' }),
      ctx(g, { rules }),
    );
    expect(resolution.resolverType).toBe('rule');
    expect(resolution.clientId).toBe('c9');
  });
});

describe('conflict detection', () => {
  it('forces review when a folder and an email disagree', () => {
    const g = emptyGraph();
    addClient(g, 'cf', 'Folder Client');
    addClient(g, 'ce', 'Email Client');
    addDomain(g, 'emailclient.com', 'ce');
    g.folders.push({
      externalId: null,
      path: 'https://ashfordsky.sharepoint.com/sites/ashfordsky/shared documents/clients/folder client',
      clientId: 'cf',
      sourceSystem: 'sharepoint',
    });
    const { resolution, winner } = runResolvers(
      interval({
        app: 'Edge',
        windowTitle: 'mail to ap@emailclient.com',
        url: 'https://ashfordsky.sharepoint.com/sites/AshfordSky/Shared%20Documents/Clients/Folder%20Client',
      }),
      ctx(g),
    );
    expect(winner?.resolverType).toBe('sharepoint_folder');
    expect(resolution.needsReview).toBe(true);
    expect(resolution.status).toBe('needs_review');
  });
});

describe('context carry-forward', () => {
  it('inherits the current client for an AI chat with no client in title', () => {
    const g = emptyGraph();
    addClient(g, 'c1', 'Widget Co');
    const { resolution } = runResolvers(
      interval({ app: 'Claude', windowTitle: 'Claude', url: 'https://claude.ai/chat/123' }),
      ctx(g, {
        currentAnchor: {
          asOf: '2026-06-22T15:58:00.000Z',
          clientId: 'c1',
          confidence: 0.95,
          anchorResolverType: 'cch_axcess',
        },
      }),
    );
    expect(resolution.clientId).toBe('c1');
    expect(resolution.resolverType).toBe('context_carry_forward');
    expect(resolution.status).toBe('suggested');
  });
});

describe('ContextEngine', () => {
  it('anchors on strong evidence and expires after the TTL', () => {
    const engine = new ContextEngine({ ttlSeconds: 1800 });
    const iv = interval({ id: 'a', startTs: '2026-06-22T16:00:00Z', endTs: '2026-06-22T16:05:00Z' });
    engine.observe(iv, {
      clientId: 'c1',
      confidence: 0.95,
      resolverType: 'cch_axcess',
      evidence: { reason: 'x' },
      needsReview: false,
    });
    const near = interval({ id: 'b', startTs: '2026-06-22T16:10:00Z', endTs: '2026-06-22T16:20:00Z' });
    expect(engine.anchorFor(near)?.clientId).toBe('c1');
    const far = interval({ id: 'c', startTs: '2026-06-22T17:00:00Z', endTs: '2026-06-22T17:05:00Z' });
    expect(engine.anchorFor(far)).toBeNull();
  });

  it('does not anchor on weak/contextual evidence', () => {
    const engine = new ContextEngine();
    const iv = interval({ id: 'a' });
    engine.observe(iv, {
      clientId: 'c1',
      confidence: 0.6,
      resolverType: 'context_carry_forward',
      evidence: { reason: 'x' },
      needsReview: false,
    });
    expect(engine.current).toBeNull();
  });
});

describe('correctionToRuleSpec', () => {
  it('maps "map this sheet forever" to an exact sheet-id rule', () => {
    const spec = correctionToRuleSpec({
      action: 'map_sheet',
      clientId: 'c1',
      payload: { sheetId: 'XYZ' },
    });
    expect(spec).toMatchObject({ ruleType: 'google_sheet_id', matchKind: 'exact', clientId: 'c1' });
  });

  it('normalizes a domain mapping', () => {
    const spec = correctionToRuleSpec({
      action: 'map_domain',
      clientId: 'c1',
      payload: { domain: 'WWW.BrightKidsCo.example/' },
    });
    expect(spec?.normalized).toBe('brightkidsco.example');
  });

  it('returns null for actions that do not imply a rule', () => {
    expect(correctionToRuleSpec({ action: 'confirm', clientId: 'c1' })).toBeNull();
  });
});
