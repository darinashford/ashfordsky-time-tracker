import {
  addOosBillingAction,
  markOosBilledAction,
  removeOosBillingAction,
  undoOosBilledAction,
} from '../lib/actions';
import type { ClientOption, OosBillingRow } from '../lib/db';

const money = (cents: number | null): string =>
  cents == null
    ? '—'
    : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const shortName = (email: string): string => email.split('@')[0] ?? email;

/**
 * The firm's "we did work outside the engagement — bill it" checklist.
 * Anyone logs an item (client + amount + what for; amount can be left unknown
 * until billing time), everything records who did what, and checking an item
 * off moves it to the completed list below.
 */
export function OosBillings({
  clients,
  rows,
  tz,
}: {
  clients: ClientOption[];
  rows: OosBillingRow[];
  tz: string;
}) {
  const fmtDay = (iso: string | null): string =>
    iso
      ? new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(new Date(iso))
      : '—';
  const open = rows.filter((r) => !r.billed);
  const done = rows.filter((r) => r.billed);
  const openKnown = open.reduce((a, r) => a + (r.amountCents ?? 0), 0);
  const openUnknown = open.filter((r) => r.amountCents == null).length;

  return (
    <>
      <h2>To bill</h2>
      <div className="card" style={{ padding: 14 }}>
        <form action={addOosBillingAction} className="actions" style={{ alignItems: 'center' }}>
          <select name="clientId" required defaultValue="">
            <option value="" disabled>
              Client…
            </option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            name="amount"
            inputMode="decimal"
            placeholder="$ amount — leave blank if unknown"
            style={{ width: 220 }}
          />
          <input type="text" name="note" placeholder="What for? (e.g. amended 2024 return)" style={{ flex: 1, minWidth: 220 }} />
          <button type="submit" className="primary">
            Add
          </button>
        </form>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Don’t know the number yet? Leave the amount blank — it shows as <strong>amount TBD</strong> and you can
          fill it in when you check it off.
        </p>

        {open.length === 0 ? (
          <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
            Nothing waiting to be billed.
          </p>
        ) : (
          <>
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>What for</th>
                  <th className="num">Amount</th>
                  <th>Added by</th>
                  <th>When</th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {open.map((r) => (
                  <tr key={r.id}>
                    <td>{r.clientName}</td>
                    <td className="muted">{r.note ?? '—'}</td>
                    <td className="num">
                      {r.amountCents != null ? (
                        money(r.amountCents)
                      ) : (
                        <span className="badge" style={{ background: '#fdf6e3', color: '#b8860b' }}>amount TBD</span>
                      )}
                    </td>
                    <td className="small">{shortName(r.createdBy)}</td>
                    <td className="small">{fmtDay(r.createdAt)}</td>
                    <td className="num">
                      <form action={markOosBilledAction} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input type="hidden" name="id" value={r.id} />
                        {r.amountCents == null && (
                          <input
                            type="text"
                            name="amount"
                            inputMode="decimal"
                            placeholder="$ billed"
                            style={{ width: 90 }}
                          />
                        )}
                        <button type="submit" className="primary small" title="Mark as invoiced — moves it to Completed below">
                          ✓ billed
                        </button>
                      </form>
                    </td>
                    <td className="num">
                      <form action={removeOosBillingAction} style={{ display: 'inline' }}>
                        <input type="hidden" name="id" value={r.id} />
                        <button type="submit" className="warn small" title="Remove — logged in error">
                          remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
              Open: <strong>{money(openKnown)}</strong>
              {openUnknown > 0 && <> + {openUnknown} item{openUnknown === 1 ? '' : 's'} with amount TBD</>}
            </p>
          </>
        )}
      </div>

      <h2>Completed</h2>
      <div className="card" style={{ padding: 14 }}>
        {done.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            Nothing billed yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>What for</th>
                <th className="num">Amount</th>
                <th>Added by</th>
                <th>Billed by</th>
                <th>Billed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {done.map((r) => (
                <tr key={r.id}>
                  <td>{r.clientName}</td>
                  <td className="muted">{r.note ?? '—'}</td>
                  <td className="num">{money(r.amountCents)}</td>
                  <td className="small">{shortName(r.createdBy)}</td>
                  <td className="small">{r.billedBy ? shortName(r.billedBy) : '—'}</td>
                  <td className="small">{fmtDay(r.billedAt)}</td>
                  <td className="num">
                    <form action={undoOosBilledAction} style={{ display: 'inline' }}>
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit" className="small" title="Checked off by mistake — send it back to the open list">
                        undo
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
