import { secondsToHours } from '@tt/shared';
import { getDailyClientSummary } from '@tt/db';
import { getDb } from '../../../../lib/db';
import { getViewerScope } from '../../../../lib/viewer';

function csv(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request, { params }: { params: { date: string } }) {
  const { pool, schema } = getDb();
  const date = params.date;
  // Owners may export one machine (?host=<person>) or the whole firm
  // (?host=all); with no param they get their own day. Non-owners always get
  // their own, whatever ?host= says — the switch is an owner permission.
  const scope = await getViewerScope();
  const qHost = new URL(req.url).searchParams.get('host') ?? undefined;
  const host = scope.isOwner
    ? qHost === 'all'
      ? undefined
      : qHost ?? scope.selfHost ?? undefined
    : scope.selfHost ?? undefined;
  const rows = await getDailyClientSummary(pool, schema, date, host);

  const header = [
    'date', 'client', 'total_hours',
    'auto_finalized_hours', 'confirmed_hours', 'suggested_hours',
    'needs_review_hours', 'unresolved_hours', 'nonbillable_hours',
    'billable_hours', 'blocks',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        date,
        csv(r.clientName ?? '(unattributed)'),
        secondsToHours(r.totalSeconds),
        secondsToHours(r.autoFinalizedSeconds),
        secondsToHours(r.confirmedSeconds),
        secondsToHours(r.suggestedSeconds),
        secondsToHours(r.needsReviewSeconds),
        secondsToHours(r.unresolvedSeconds),
        secondsToHours(r.nonbillableSeconds),
        secondsToHours(r.billableSeconds),
        r.intervalCount,
      ].join(','),
    );
  }

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="time-${date}.csv"`,
    },
  });
}
