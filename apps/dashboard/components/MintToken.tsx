'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { mintTokenAction, type MintTokenState } from '../lib/actions';

const INSTALL_CMD =
  'irm https://raw.githubusercontent.com/darinashford/ashfordsky-time-tracker/main/scripts/install.ps1 | iex';

function SubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="primary" disabled={pending}>
      {pending ? 'Creating…' : 'Add person'}
    </button>
  );
}

/**
 * Mint a sync token for a new person, right from Settings (no CLI). The token
 * is shown ONCE — only its hash is stored — together with the one-line
 * installer to send them.
 */
export function MintToken() {
  const [state, formAction] = useFormState<MintTokenState, FormData>(mintTokenAction, { ok: false });
  return (
    <div className="card" style={{ padding: 14 }}>
      <form action={formAction} className="actions" style={{ alignItems: 'center' }}>
        <label className="small muted">
          Short id{' '}
          <input type="text" name="host" placeholder="jane" required style={{ width: 120, marginLeft: 4 }} />
        </label>
        <label className="small muted">
          Full name{' '}
          <input type="text" name="label" placeholder="Jane Smith" style={{ width: 180, marginLeft: 4 }} />
        </label>
        <SubmitBtn />
        <span className="small muted">
          Short id must be their email name (alex@ashfordsky.com → “alex”) — it links their login to their time.
        </span>
      </form>

      {state.error && (
        <p className="small" style={{ color: '#c0392b', marginTop: 10, marginBottom: 0 }}>{state.error}</p>
      )}

      {state.ok && state.token && (
        <div style={{ marginTop: 12, border: '1px solid #b8860b', borderRadius: 8, padding: 12, background: '#fdf6e3' }}>
          <p className="small" style={{ marginTop: 0 }}>
            <strong>Token for “{state.host}” — copy it now, it is shown only this once</strong> (only a hash is
            stored). Send it via a password manager or other secure channel — not email or chat.
          </p>
          <pre className="small mono" style={{ userSelect: 'all', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0' }}>
            {state.token}
          </pre>
          <p className="small" style={{ marginBottom: 4 }}>Then have them paste this one line into PowerShell (it installs everything and asks for the token):</p>
          <pre className="small mono" style={{ userSelect: 'all', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
            {INSTALL_CMD}
          </pre>
        </div>
      )}
    </div>
  );
}
