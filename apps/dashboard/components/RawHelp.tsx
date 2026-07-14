/**
 * The two informational tabs on the Raw Data page:
 *  - LabelsHelp: what every attribution-reason group heading actually means and
 *    how much to trust it (headings must match reasonOf() in Timeline.tsx).
 *  - HowItWorks: the pipeline — sync cadence, block building, how a client is
 *    chosen, confidence thresholds, idle/call handling, screenshots, AI pass.
 */

const badge = (bg: string, fg: string, text: string) => (
  <span className="badge" style={{ background: bg, color: fg, whiteSpace: 'nowrap' }}>{text}</span>
);
const CONFIDENT = () => badge('#e8f5ec', '#1f8a4c', 'Confident');
const LIKELY = () => badge('#fdf6e3', '#b8860b', 'Likely');
const UNCERTAIN = () => badge('#fdecea', '#c0392b', 'Uncertain');
const UNKNOWN = () => badge('#eef0f2', '#566573', 'Unknown');
const NONBILL = () => badge('#eef0f2', '#566573', 'Non-billable');

interface LabelRow {
  label: string;
  trust: () => JSX.Element;
  meaning: string;
}

const LABELS: LabelRow[] = [
  {
    label: 'You set the client yourself',
    trust: CONFIDENT,
    meaning:
      'You confirmed the block, changed its client, or logged it as a manual entry. This always wins: the sync and the resolver never overwrite it.',
  },
  {
    label: 'Matched a rule you created',
    trust: CONFIDENT,
    meaning:
      'A durable rule saved from one of your past corrections (an app, window title, or web domain you mapped to this client) matched this block. Auto-finalizes at ~97% confidence.',
  },
  {
    label: 'In their accounting system (CCH / QBO / Financial Cents)',
    trust: CONFIDENT,
    meaning:
      'The open record WAS this client: their CCH Axcess return, their QuickBooks Online company, or their Financial Cents workspace, matched by the ID in the window/URL. Near-certain, auto-finalizes.',
  },
  {
    label: 'On a call or calendar meeting with this client',
    trust: CONFIDENT,
    meaning:
      'A calendar event or the Krisp meetings log covered this time and identified the client (by attendees or meeting title) — or the block is part of the same continuous call as an identified meeting (a call that ran past its logged end keeps its client as a suggestion).',
  },
  {
    label: 'An email tied to this client was on screen',
    trust: CONFIDENT,
    meaning:
      'In an email window, the message matched the client: an exact contact address (strongest, auto-finalizes), their email domain, or a subject line that is already filed under this client in your inbox. Only fires in a real mail app/webmail — never on an ordinary browser tab.',
  },
  {
    label: 'Working in a file or folder mapped to this client',
    trust: CONFIDENT,
    meaning:
      'The SharePoint/Drive folder path, Google Sheet, or Excel workbook is one that is mapped to this client in the database.',
  },
  {
    label: 'The client’s name was in the window title',
    trust: LIKELY,
    meaning:
      'The document, browser tab, or window title contained the client’s (or an alias’s) name. Strong but not certain (~68%) — name collisions happen — so it lands as a suggestion for you to confirm.',
  },
  {
    label: 'On a website tied to this client',
    trust: LIKELY,
    meaning: 'The web domain on screen is mapped to this client (e.g. their company site or portal).',
  },
  {
    label: 'Their chat workspace or AI chat content',
    trust: LIKELY,
    meaning:
      'A Slack/Teams workspace named for the client, or an AI-chat conversation whose visible content identified them.',
  },
  {
    label: 'The screenshot text identified this client',
    trust: LIKELY,
    meaning:
      'A low-confidence block had a screenshot taken; reading its text (OCR) found the client’s email address or domain on screen.',
  },
  {
    label: 'AI judgement from the window content',
    trust: LIKELY,
    meaning:
      'The optional AI pass classified a leftover block the rules couldn’t place. It is never allowed to auto-bill — its picks are always capped and left as suggestions for you.',
  },
  {
    label: 'Carried over from what you were doing just before',
    trust: LIKELY,
    meaning:
      'This window had no client signal of its own (e.g. Excel with a generic title), but you were confidently working on this client moments earlier — within the last 30 minutes — so it assumes the work continued. 60% confidence; a suggestion you should confirm. A recognized context switch (a different client’s email, a prospect call, social media) breaks the chain.',
  },
  {
    label: 'Borrowed from the surrounding activity',
    trust: UNCERTAIN,
    meaning:
      'The weakest signal, applied last. The block had no signal of its own AND no recent context to carry forward — so after everything else ran, it borrowed the client from the nearest confidently-attributed block within 30 minutes before or after it. Only 45% confidence: it always lands in Uncertain and is never billed without your review.',
  },
  {
    label: 'No client signal found',
    trust: UNKNOWN,
    meaning:
      'Nothing matched: no rule, meeting, email, file, name, website, or nearby context. The block stays unattributed until you assign it (or the AI pass suggests something).',
  },
  {
    label: 'Non-billable — …',
    trust: NONBILL,
    meaning:
      'Recognized as a known non-billable category instead of client work — e.g. “Calls — prospects / vendors” (a live call that didn’t identify to any client), email/admin, development/tools, social, news, music, personal/travel, firm tooling. The suffix names the bucket; these never bill to a client.',
  },
];

export function LabelsHelp() {
  return (
    <>
      <p className="small muted" style={{ maxWidth: 760 }}>
        Every block below is grouped under the reason it was (or wasn’t) matched to a client. The groups,
        strongest to weakest — and exactly how much to trust each:
      </p>
      <table>
        <thead>
          <tr>
            <th style={{ width: '30%' }}>Group heading</th>
            <th style={{ width: 110 }}>Trust</th>
            <th>What it actually means</th>
          </tr>
        </thead>
        <tbody>
          {LABELS.map((l) => (
            <tr key={l.label}>
              <td><strong>{l.label}</strong></td>
              <td>{l.trust()}</td>
              <td className="small">{l.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 10, maxWidth: 760 }}>
        The status pills at the top of the Blocks tab are the same idea from the billing side:{' '}
        <strong>Confident</strong> = auto-finalized or confirmed by you; <strong>Likely</strong> = suggested,
        counts as billable pending your confirm; <strong>Uncertain</strong> = needs review, not billed until you
        decide; <strong>Unknown</strong> = no attribution at all; <strong>Non-billable</strong> = bucketed, never billed.
      </p>
    </>
  );
}

export function HowItWorks({
  autoFinalizeThreshold,
  reviewThreshold,
  awayCutoffSeconds,
  screenshotsEnabled,
  screenshotStableSeconds,
  screenshotRetentionDays,
  llmEnabled,
}: {
  autoFinalizeThreshold: number;
  reviewThreshold: number;
  awayCutoffSeconds: number;
  screenshotsEnabled: boolean;
  screenshotStableSeconds: number;
  screenshotRetentionDays: number;
  llmEnabled: boolean;
}) {
  const autoPct = Math.round(autoFinalizeThreshold * 100);
  const revPct = Math.round(reviewThreshold * 100);
  const awayMin = Math.round(awayCutoffSeconds / 60);
  return (
    <div style={{ maxWidth: 780 }}>
      <h2 style={{ marginTop: 4 }}>1 · Watching &amp; the 10-minute sync</h2>
      <p className="small">
        <strong>ActivityWatch</strong> runs on each person’s computer and records, locally, which window is
        focused (app + title + URL) and whether the keyboard/mouse are idle. Every <strong>10 minutes</strong> a
        background Windows task (<span className="mono">AshfordSky-TimeTracker-Sync</span>) wakes up, reads the
        new activity, and syncs it — it does not need any app, browser, or terminal to be open. Your machine
        writes straight to the database; teammates’ machines send theirs with a personal token (no database
        access) and the server stamps whose time it is. The green “Synced N min ago” pill on Today is this
        heartbeat.
      </p>

      <h2>2 · Raw events become blocks</h2>
      <p className="small">
        The sync merges window events into <strong>blocks</strong> (the rows on this page): one stretch of one
        app/window. Blocks keep stable identities between syncs, so re-syncing never re-shuffles what you’ve
        already confirmed. Blocks you created or corrected by hand are never deleted or overwritten by the sync.
      </p>

      <h2>3 · How a client is chosen</h2>
      <p className="small">
        The matcher loads your live client graph from the firm database (Supabase): every active client plus
        their aliases — contact emails, email domains, entity/person names, mapped folders and spreadsheets,
        CCH / QuickBooks / Financial Cents IDs, learned inbox subjects — and your calendar + the Krisp meetings
        log. Then a chain of matchers runs over each block, strongest first: your rules → calendar/meetings →
        accounting-system IDs → mapped sheets/files/folders → emails → websites → chat/AI content → the client’s
        name in the title → screenshot text (OCR) → and only then the two inference fallbacks (“carried over”,
        “borrowed”). Each proposes a client with a confidence; the strongest signal wins. The{' '}
        <strong>What the labels mean</strong> tab explains every outcome.
      </p>

      <h2>4 · Confidence → status</h2>
      <p className="small">
        Every attribution carries a confidence. At or above <strong>{autoPct}%</strong> it{' '}
        <strong>auto-finalizes</strong> (Confident — billed, no action needed). From <strong>{revPct}%</strong>{' '}
        to {autoPct}% it becomes a <strong>suggestion</strong> (Likely — counted as billable, waiting for your
        confirm). Below {revPct}% it goes to <strong>review</strong> (Uncertain — not billed until you decide).
        No signal at all = Unknown. Anything you set yourself is 100% and frozen. Recognized non-client activity
        goes to a named non-billable bucket instead.
      </p>

      <h2>5 · Idle time &amp; calls</h2>
      <p className="small">
        No input for 3+ minutes marks a block idle. Idle during a meeting/call, or while reading a client’s
        work, is promoted back to counted time (you were working — just not typing). An unbroken idle stretch
        longer than <strong>{awayMin} minutes</strong> is treated as away (lunch, gone from desk) and not
        counted — <em>except on a live call</em>, where listening time counts in full. A continuous call keeps
        its identified client for the whole call, even past the meeting’s logged end; a call that never
        identifies to a client is bucketed “Calls — prospects / vendors”, never silently billed to the previous
        client. Off-computer time (a lunch, a site visit) can be added as a manual entry on Today.
      </p>

      <h2>6 · Screenshots</h2>
      <p className="small">
        {screenshotsEnabled ? (
          <>
            Screenshots are <strong>on</strong>, and deliberately narrow: they’re taken only for{' '}
            <strong>low-confidence blocks</strong> (the matcher wants more evidence), only after the same window
            has been on screen ~{screenshotStableSeconds}s, never for excluded apps/sites (password managers,
            banking — and you can exclude more). They stay on the local machine, are kept{' '}
            {screenshotRetentionDays} days, and their text (OCR) feeds attribution — “The screenshot text
            identified this client”.
          </>
        ) : (
          <>
            Screenshots are currently <strong>off</strong>. When enabled they’re taken only for low-confidence
            blocks after ~{screenshotStableSeconds}s of a stable window, never for excluded apps/sites (password
            managers, banking), stored locally, kept {screenshotRetentionDays} days, and read (OCR) to help
            identify the client.
          </>
        )}
      </p>

      <h2>7 · The AI pass</h2>
      <p className="small">
        {llmEnabled ? 'Enabled: an' : 'Optional (currently off): an'} AI model periodically looks at leftover
        blocks the rules couldn’t place — ambiguous AI/dev/email time — and classifies each as a specific
        client, firm tooling, or unknown. Its picks are <strong>never auto-billed</strong>: they arrive as
        suggestions for your confirm, and its daily cost shows on the dashboard.
      </p>

      <h2>8 · Your corrections teach it</h2>
      <p className="small">
        Confirming or reassigning a block writes a correction; from a correction you can mint a durable rule
        (“this title/app/domain is always this client”) that auto-finalizes the same activity forever after.
        Manual work always wins over the machine, and everything the machine did — every vote, every reason — is
        auditable on this page via each block’s “why”.
      </p>
    </div>
  );
}
