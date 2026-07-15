import { getDb } from '../../lib/db';
import { HowItWorks } from '../../components/RawHelp';

export const dynamic = 'force-dynamic';

/**
 * "How this works" — the full pipeline explainer as its own page, in the
 * sidebar, visible to every signed-in user (not owner-gated like Settings).
 * Renders the same HowItWorks component the Raw Data tab uses, so there is one
 * source of truth for the copy.
 */
export default function HowPage() {
  const { cfg } = getDb();
  return (
    <>
      <div className="topbar">
        <h1>How this works</h1>
      </div>
      <HowItWorks
        autoFinalizeThreshold={cfg.autoFinalizeThreshold}
        reviewThreshold={cfg.reviewThreshold}
        awayCutoffSeconds={cfg.awayCutoffSeconds}
        screenshotsEnabled={cfg.screenshotsEnabled}
        screenshotStableSeconds={cfg.screenshotStableSeconds}
        screenshotRetentionDays={cfg.screenshotRetentionDays}
        llmEnabled={cfg.llmEnabled}
      />
    </>
  );
}
