import type { RuleRow } from '../lib/db';
import { toggleRuleAction } from '../lib/actions';
import { ruleRisk } from '../lib/learn';

/** Plain-English description of what a rule matches on. */
function describe(r: RuleRow): string {
  const p = `“${r.pattern}”`;
  switch (r.ruleType) {
    case 'title_pattern':
      return `Any window whose title contains ${p}`;
    case 'url_host':
      return `Any page on the website ${p}`;
    case 'email_domain':
      return `Any email from the domain ${p}`;
    case 'email_address':
      return `Email from ${p}`;
    case 'sheet_id':
      return `The Google Sheet ${p}`;
    case 'folder':
      return `Files in the folder ${p}`;
    default:
      return `${r.ruleType.replace(/_/g, ' ')} ${r.matchKind} ${p}`;
  }
}

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

/**
 * Audit of every rule "set client · remember" has taught the engine: what it
 * matches, who made it, from whose block, and how many blocks it now claims — so
 * an over-broad rule (a generic word matching hundreds of blocks) is easy to
 * spot and switch off. Owner-only.
 */
export function RulesTable({ rows, canEdit }: { rows: RuleRow[]; canEdit: boolean }) {
  if (rows.length === 0) {
    return <p className="muted small">No rules yet. Rules appear here when someone uses “set client” with “remember” on.</p>;
  }
  // Surface likely-bad rules first: an enabled rule with a risky pattern, then
  // by how many blocks it's claiming. Disabled rules sink to the bottom.
  const ranked = [...rows]
    .map((r) => ({ r, risk: r.enabled ? ruleRisk(r.ruleType, r.pattern) : null }))
    .sort((a, b) => {
      if (a.r.enabled !== b.r.enabled) return a.r.enabled ? -1 : 1;
      const ar = a.risk ? 1 : 0;
      const br = b.risk ? 1 : 0;
      if (ar !== br) return br - ar;
      return b.r.blocksHit - a.r.blocksHit;
    });
  const flagged = ranked.filter((x) => x.risk).length;
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Every rule taught by “set client · remember”. A rule with a vague pattern claiming a lot of blocks is
        usually a mistake — disable it here (nothing is deleted; it just stops matching on the next resolve).
        {flagged > 0 && (
          <>
            {' '}
            <strong style={{ color: '#c0392b' }}>{flagged} look over-broad</strong> and are pulled to the top.
          </>
        )}
      </p>
      <table>
        <thead>
          <tr>
            <th>What it matches</th>
            <th>→ Client</th>
            <th>Created by</th>
            <th>When</th>
            <th className="num">Blocks</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(({ r, risk }) => (
            <tr key={r.id} style={r.enabled ? undefined : { opacity: 0.5 }}>
              <td>
                {describe(r)}
                {!r.enabled && <span className="badge" style={{ marginLeft: 6, background: '#eef0f2', color: '#566573' }}>off</span>}
                {risk && (
                  <div className="small" style={{ color: '#c0392b', marginTop: 2 }}>⚠ looks over-broad — {risk}</div>
                )}
              </td>
              <td>{r.clientName ?? <span className="muted">—</span>}</td>
              <td className="small">
                {r.createdBy ?? <span className="muted">—</span>}
                {r.fromHost && <div className="muted small">from {r.fromHost}’s block</div>}
              </td>
              <td className="small">{when(r.createdAt)}</td>
              <td className="num" style={r.enabled && r.blocksHit >= 100 ? { color: '#c0392b', fontWeight: 600 } : undefined}>
                {r.blocksHit}
              </td>
              <td className="num">
                {canEdit && (
                  <form action={toggleRuleAction} style={{ display: 'inline' }}>
                    <input type="hidden" name="ruleId" value={r.id} />
                    {r.enabled ? (
                      <button type="submit" className="warn small">disable</button>
                    ) : (
                      <>
                        <input type="hidden" name="enable" value="1" />
                        <button type="submit" className="small">enable</button>
                      </>
                    )}
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
