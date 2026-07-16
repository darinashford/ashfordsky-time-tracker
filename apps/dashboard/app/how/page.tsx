import { getScreenshotActivity } from '@tt/db';
import { getDb } from '../../lib/db';
import { HowItWorks } from '../../components/RawHelp';

export const dynamic = 'force-dynamic';

/**
 * "How this works" — the full pipeline explainer as its own page, in the
 * sidebar, visible to every signed-in user (not owner-gated like Settings).
 * Renders the same HowItWorks component the Raw Data tab uses, so there is one
 * source of truth for the copy.
 */
export default async function HowPage() {
  const { pool, schema, cfg } = getDb();
  // Capture runs on each person's machine, not this web server — so trust real
  // recent activity in the DB over the dashboard's own env var.
  const shots = await getScreenshotActivity(pool, schema).catch(() => null);
  return (
    <>
      <div className="topbar">
        <h1>How this works</h1>
      </div>
      <HowItWorks
        autoFinalizeThreshold={cfg.autoFinalizeThreshold}
        reviewThreshold={cfg.reviewThreshold}
        awayCutoffSeconds={cfg.awayCutoffSeconds}
        idleGraceSeconds={cfg.idleGraceSeconds}
        screenshotsEnabled={cfg.screenshotsEnabled || (shots?.active ?? false)}
        screenshotStoresLocally={(shots?.storedLocal ?? 0) > 0}
        screenshotStableSeconds={cfg.screenshotStableSeconds}
        screenshotRetentionDays={cfg.screenshotRetentionDays}
        llmEnabled={cfg.llmEnabled}
      />
    </>
  );
}
