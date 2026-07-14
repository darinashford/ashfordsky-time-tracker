import { deleteManualEntryAction, manualEntryAction } from '../lib/actions';
import type { ClientOption, ManualEntryRow } from '../lib/db';

/** "1:30p" style local time for the entries list. */
function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso))
    .toLowerCase()
    .replace(' ', '');
}

function fmtDur(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${m}m`;
}

/**
 * Log a block by hand from the Today view — a client lunch, an off-computer
 * meeting, drive time. It becomes a real block (source='manual', confirmed to
 * the picked client) that flows through every report, survives the sync, and
 * can be deleted here.
 */
export function ManualEntry({
  date,
  host,
  tz,
  clients,
  entries,
}: {
  date: string;
  host: string | null;
  tz: string;
  clients: ClientOption[];
  entries: ManualEntryRow[];
}) {
  return (
    <>
      <h2>Manual entries</h2>
      <div className="card" style={{ padding: 14 }}>
        <form action={manualEntryAction} className="actions" style={{ alignItems: 'center' }}>
          <input type="hidden" name="date" value={date} />
          {host && <input type="hidden" name="host" value={host} />}
          <label className="small muted">
            Start{' '}
            <input type="time" name="start" defaultValue="12:00" required style={{ marginLeft: 4 }} />
          </label>
          <label className="small muted">
            Minutes{' '}
            <input
              type="number"
              name="minutes"
              defaultValue={30}
              min={1}
              max={1440}
              required
              style={{ width: 70, marginLeft: 4 }}
            />
          </label>
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
            name="note"
            placeholder="What was it? (e.g. Lunch — quarterly planning)"
            style={{ flex: 1, minWidth: 220 }}
          />
          <label className="small muted" style={{ whiteSpace: 'nowrap' }}>
            <input type="checkbox" name="billable" defaultChecked style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Billable
          </label>
          <button type="submit" className="primary">
            Add entry
          </button>
        </form>

        {entries.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Duration</th>
                <th>Client</th>
                <th>Note</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{fmtTime(e.startTs, tz)}</td>
                  <td>{fmtDur(e.durationSeconds)}</td>
                  <td>{e.clientName ?? '—'}</td>
                  <td className="muted">{e.note === 'Manual entry' ? '—' : e.note}</td>
                  <td>{e.isBillable ? <span className="badge" style={{ background: '#e8f5ec', color: '#1f8a4c' }}>billable</span> : <span className="badge">non-billable</span>}</td>
                  <td className="num">
                    <form action={deleteManualEntryAction} style={{ display: 'inline' }}>
                      <input type="hidden" name="date" value={date} />
                      <input type="hidden" name="intervalId" value={e.id} />
                      <button type="submit" className="warn small">
                        delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
          Manual entries are confirmed to the client immediately, survive every sync, and show up in
          all reports like any other block (grouped under “You set the client yourself” in Raw Data).
        </p>
      </div>
    </>
  );
}
