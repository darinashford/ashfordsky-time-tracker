import { redirect } from 'next/navigation';
import { getViewerScope } from '../../lib/viewer';
import { listRules } from '../../lib/db';
import { RulesTable } from '../../components/RulesTable';

export const dynamic = 'force-dynamic';

/**
 * Manual Rules — the audit of everything "set client · remember" has taught the
 * engine. Owner-only, since rules apply firm-wide. This is where an over-broad
 * learned rule (a generic word claiming lots of blocks) gets spotted and shut off.
 */
export default async function RulesPage() {
  if (!(await getViewerScope()).isOwner) redirect('/day/today');
  const rules = await listRules().catch(() => []);
  return (
    <>
      <div className="topbar">
        <h1>Manual Rules</h1>
      </div>
      <RulesTable rows={rules} canEdit />
    </>
  );
}
