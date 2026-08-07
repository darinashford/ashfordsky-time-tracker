import { getDb, listClientOptions, listOosBillings } from '../../lib/db';
import { OosBillings } from '../../components/OosBillings';

export const dynamic = 'force-dynamic';

/**
 * Out of Scope Billings — work done outside the engagement that still has to be
 * invoiced. A shared checklist for the whole firm (any signed-in staff member
 * can add and check off; every action records who), deliberately NOT tied to
 * tracked time: this is "remember to bill X", not "X hours were worked".
 */
export default async function OosPage() {
  const { cfg } = getDb();
  const [clients, rows] = await Promise.all([listClientOptions(), listOosBillings()]);
  return (
    <>
      <div className="topbar">
        <h1>Out of Scope Billings</h1>
      </div>
      <OosBillings clients={clients} rows={rows} tz={cfg.timezone} />
    </>
  );
}
