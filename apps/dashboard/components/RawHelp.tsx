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
      'The weakest signal, applied last. The block had no signal of its own AND no recent context to carry forward — so after everything else ran, it borrowed the client from the nearest confidently-attributed block within 30 minutes before or after it. Only 45% confidence, so it lands in Uncertain and is worth a review — but because it is attributed to a client it still counts as billable.',
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
        The status pills at the top of the Blocks tab are your <em>confidence</em> in the attribution — a review
        signal, not a billing gate. Any block tied to a client is billable: <strong>Confident</strong> =
        auto-finalized or confirmed by you; <strong>Likely</strong> = suggested; <strong>Uncertain</strong> = tied
        to a client but low-confidence, so still billed but worth a look; <strong>Unknown</strong> = no attribution
        at all (not billed); <strong>Non-billable</strong> = bucketed, never billed.
      </p>
    </>
  );
}

export function HowItWorks({
  autoFinalizeThreshold,
  reviewThreshold,
  awayCutoffSeconds,
  idleGraceSeconds = 600,
  screenshotsEnabled,
  screenshotStoresLocally = false,
  screenshotStableSeconds,
  screenshotRetentionDays,
  llmEnabled,
}: {
  autoFinalizeThreshold: number;
  reviewThreshold: number;
  awayCutoffSeconds: number;
  idleGraceSeconds?: number;
  screenshotsEnabled: boolean;
  screenshotStoresLocally?: boolean;
  screenshotStableSeconds: number;
  screenshotRetentionDays: number;
  llmEnabled: boolean;
}) {
  const autoPct = Math.round(autoFinalizeThreshold * 100);
  const revPct = Math.round(reviewThreshold * 100);
  const awayMin = Math.round(awayCutoffSeconds / 60);
  const idleMin = Math.round(idleGraceSeconds / 60);
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
        <strong>auto-finalizes</strong> (Confident — no action needed). From <strong>{revPct}%</strong>{' '}
        to {autoPct}% it becomes a <strong>suggestion</strong> (Likely). Below {revPct}% it goes to{' '}
        <strong>review</strong> (Uncertain — worth a look). All three are attributed to a client, so all three
        are billable — confidence just tells you how much review each deserves. No signal at all = Unknown (not
        billed). Anything you set yourself is 100% and frozen. Recognized non-client activity goes to a named
        non-billable bucket instead.
      </p>

      <h2>5 · Idle time &amp; calls</h2>
      <p className="small">
        A no-input stretch under <strong>{idleMin} minutes</strong> is a pause at the desk — reading, thinking,
        listening on a call — and still counts as working, attributed like the block around it. Only{' '}
        <strong>{idleMin}+ minutes</strong> with no input marks a block genuinely idle. Idle during a
        meeting/call, or while reading a client’s work, is promoted back to counted time. An unbroken idle
        stretch longer than <strong>{awayMin} minutes</strong> is treated as away (lunch, gone from desk) and
        not counted — <em>except on a live call</em>, where listening time counts in full.
      </p>
      <p className="small">
        A call is tied to a client by <strong>who was on it</strong> — the calendar / Krisp attendees — so a
        client meeting bills to that client for the <strong>whole call</strong>, even past the meeting’s logged
        end and even when the title doesn’t name them (a “COGS Discussion” with the client’s people on it still
        lands on that client; sibling entities in one ownership group count as the same client). A call with no
        client among its attendees is bucketed “Calls — prospects / vendors”, never silently billed to the
        previous client. Off-computer time (a lunch, a site visit) can be added as a manual entry on Today.
      </p>

      <h2>6 · Screenshots</h2>
      <p className="small">
        {screenshotsEnabled ? (
          <>
            Screenshots are <strong>on</strong> and deliberately narrow: one is taken only when a block needs more
            evidence to name the client — the current email/inbox window, or a{' '}
            <strong>low-confidence block</strong> — and only after that window has been stable ~
            {screenshotStableSeconds}s. Excluded apps/sites (password managers, banking) are never captured. What’s
            kept is the <strong>text</strong> (OCR), which feeds attribution — “The screenshot text identified this
            client”. Capture runs on <em>each person’s own machine</em>, never on the web server.
          </>
        ) : (
          <>
            Screenshots are currently <strong>off</strong> here. When on, one is taken only for the current
            email/inbox window or a low-confidence block, after ~{screenshotStableSeconds}s of a stable window,
            never for excluded apps/sites (password managers, banking), and read (OCR) to help name the client.
          </>
        )}
      </p>
      {screenshotsEnabled && (
        <p className="small">
          <strong>Where the image goes.</strong>{' '}
          {screenshotStoresLocally ? (
            <>
              On the owner’s machine the PNG is written to the app’s{' '}
              <span className="mono">.data/screenshots/&lt;date&gt;/</span> folder, kept{' '}
              {screenshotRetentionDays} days, then auto-deleted. It is not uploaded to the dashboard or the
              database — but note that if the app folder sits inside a synced location (e.g. OneDrive), that
              folder will sync the images like any other file; point <span className="mono">SCREENSHOT_DIR</span>{' '}
              at a non-synced path to keep them strictly on the machine.
            </>
          ) : (
            <>The image is read in memory to pull its text and then discarded — nothing is written to disk.</>
          )}{' '}
          On teammates’ machines capture runs in <strong>OCR-only</strong> mode: the screen is read locally and{' '}
          <em>only the extracted text</em> is uploaded — the image is never stored or sent.
        </p>
      )}

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

      <h2>9 · What the Today numbers mean</h2>
      <p className="small">
        The tiles at the top of <strong>Today</strong> read left-to-right, from “everything” to “the part that
        bills”:
      </p>
      <ul className="small" style={{ marginTop: 4, lineHeight: 1.7 }}>
        <li>
          <strong>Total on computer</strong> — Active time plus counted idle. A locked screen is excluded, so
          this is time you were actually at the machine.
        </li>
        <li>
          <strong>Active</strong> — time you were driving the machine, with idle removed.
        </li>
        <li>
          <strong>Billable</strong> — all client work: every block attributed to a client, regardless of
          confidence (Confident + Likely + Uncertain). Only Unknown (no client) and non-billable buckets are
          excluded.
        </li>
        <li>
          <strong>Confident</strong> — the share of your Active time that landed on a strong, direct signal (or
          that you confirmed): no action needed.
        </li>
        <li>
          <strong>Uncertain</strong> — client time on a weak or conflicting signal. Still billable, but flagged so
          you know which time is worth a quick review.
        </li>
      </ul>
      <p className="small">
        The <strong>Coverage / accuracy</strong> bar splits that same Active time into statuses by share:{' '}
        <strong>confident</strong> (auto-finalized) + <strong>confirmed</strong> (by you) are the trustworthy
        core; <strong>likely</strong> are suggestions; <strong>uncertain</strong> needs review;{' '}
        <strong>non-billable</strong> is bucketed; <strong>unknown</strong> has no attribution yet.{' '}
        <strong>Screenshot-supported</strong> is listed separately — the slice whose attribution had an on-screen
        screenshot (OCR) behind it.
      </p>

      <h2>10 · Privacy &amp; where your data lives</h2>
      <p className="small">
        Activity is recorded <strong>locally</strong> by ActivityWatch on each person’s own machine. Screenshots
        (when on) <strong>never leave that machine</strong> — they’re stored locally, read for text on-device, and
        deleted after {screenshotRetentionDays} days. What syncs to the firm database (Supabase) is the
        attribution data — app / window title / URL, timings, and the chosen client — <em>not</em> the
        screenshots. Teammates’ machines have <strong>no database access</strong>: they send their time through a
        personal token and the server stamps whose it is; only the owner’s machine writes directly. Revoking a
        token stops new time immediately, without deleting anything already recorded.
      </p>
    </div>
  );
}
