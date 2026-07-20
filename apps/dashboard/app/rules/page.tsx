import { listRules } from '../../lib/db';
import { RulesTable } from '../../components/RulesTable';

export const dynamic = 'force-dynamic';

/**
 * Manual Rules — the audit of everything "set client · remember" has taught the
 * engine. Rules apply firm-wide, so any signed-in staff member can view and
 * toggle them (Settings — tokens/people — stays owner-only). This is where an
 * over-broad learned rule (a generic word claiming lots of blocks) gets spotted
 * and shut off.
 */
export default async function RulesPage() {
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
