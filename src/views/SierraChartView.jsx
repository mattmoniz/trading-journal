import React, { useState, useCallback, useEffect } from 'react';
import { API_URL } from '../constants/api.js';
import { useViewActive } from '../utils/useViewActive.js';

const POLL_MS = 5000;

const STATE_COLOR = {
  LIVE: '#4ade80',
  LOGGED_ON_STALE: '#facc15',
  CONNECTED_NOT_LOGGED_ON: '#facc15',
  DISCONNECTED: '#f87171',
  NOT_CONFIGURED: '#94a3b8',
  NOT_STARTED: '#94a3b8',
};

function StatusDot({ state }) {
  const color = STATE_COLOR[state] || '#94a3b8';
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, marginRight: 8 }} />;
}

const SOURCE_FILTERS = ['ALL', 'APP', 'MANUAL', 'OTHER'];
const TYPE_FILTERS = ['ALL', 'ENTRY', 'STOP', 'EXIT', 'FILLED', 'CANCELED', 'REJECTED'];

function ActivityLog() {
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState(null);
  const [srcF, setSrcF] = useState('ALL');
  const [typeF, setTypeF] = useState('ALL');
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`${API_URL}/sierra-chart/activity?limit=200`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) { setEvents(d.events || []); setErr(null); } })
      .catch(() => { if (alive) setErr('Could not load activity'); });
    load();
    const id = setInterval(load, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return (
    <Card title={`Activity log (${events ? events.length : '…'})`}>
      {err && <div style={{ color: '#fca5a5', fontSize: 13 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {SOURCE_FILTERS.map(f => (
          <button key={'s' + f} onClick={() => setSrcF(f)} style={{ padding: '4px 8px', fontSize: 12, background: srcF === f ? '#334155' : 'transparent', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4 }}>source: {f}</button>
        ))}
        {TYPE_FILTERS.map(f => (
          <button key={'t' + f} onClick={() => setTypeF(f)} style={{ padding: '4px 8px', fontSize: 12, background: typeF === f ? '#334155' : 'transparent', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 4 }}>type: {f}</button>
        ))}
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
        {(events || []).filter(e => (srcF === 'ALL' || e.source === srcF) && (typeF === 'ALL' || e.purpose === typeF || e.event === typeF)).map((e, i) => (
          <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid #1e293b', color: e.source === 'APP' ? '#93c5fd' : '#e2e8f0' }}>
            <span style={{ color: '#64748b' }}>{e.at}</span> <span style={{ color: '#a5b4fc' }}>[{e.source}]</span>{' '}
            {e.purpose ? `${e.purpose} ` : ''}{e.event}
            {e.raw_fill ? ` @ ${(Number(e.raw_fill) * 0.00999999776482582).toFixed(2)}` : ''}
            {e.qty ? ` x${e.qty}` : ''}{e.setup_id ? ` · setup ${e.setup_id}` : ''}{e.info ? ` · ${e.info}` : ''}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value, color }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#94a3b8' }}>{label}</div>
      <div style={{ fontSize: 15, color: color || '#e2e8f0', fontFamily: 'monospace' }}>{value ?? '—'}</div>
    </div>
  );
}

export default function SierraChartView() {
  const isViewActive = useViewActive();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionReport, setActionReport] = useState(null);

  const load = useCallback(() => {
    fetch(`${API_URL}/sierra-chart/status`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { setStatus(d); setError(null); })
      .catch((e) => setError(e.message));
  }, []);

  React.useEffect(() => {
    if (!isViewActive) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [isViewActive, load]);

  const doStart = async () => {
    setBusy(true); setActionReport(null);
    try {
      const r = await fetch(`${API_URL}/sierra-chart/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'dashboard-user' }) });
      setActionReport({ kind: 'start', data: await r.json() });
      load();
    } catch (e) { setActionReport({ kind: 'start', error: e.message }); }
    setBusy(false);
  };

  const doStop = async () => {
    if (!window.confirm('Stop trading? This will cancel/flatten every REAL order this app has open (never touching anything else on the account) and halt new entries.')) return;
    setBusy(true); setActionReport(null);
    try {
      const r = await fetch(`${API_URL}/sierra-chart/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'dashboard-user' }) });
      setActionReport({ kind: 'stop', data: await r.json() });
      load();
    } catch (e) { setActionReport({ kind: 'stop', error: e.message }); }
    setBusy(false);
  };

  if (error) return <div style={{ padding: 24, color: '#f87171' }}>Failed to load: {error}</div>;
  if (!status) return <div style={{ padding: 24, color: '#94a3b8' }}>Loading…</div>;

  const { connection, contract, recentOrders } = status;
  const armed = connection.killSwitch?.armed;
  const recon = connection.lastReconciliationReport;

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>
      <h2 style={{ color: '#e2e8f0', marginBottom: 16 }}>Sierra Chart — Order Placement</h2>

      <Card title="Connection & Environment">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <StatusDot state={connection.state} />
          <span style={{ fontSize: 16, color: '#e2e8f0', fontWeight: 600 }}>{connection.state}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="Service (which real environment)" value={connection.service} color={connection.service === 'rithmic_v2.trading' ? '#4ade80' : '#facc15'} />
          <Field label="Trade Account" value={connection.tradeAccount} />
          <Field label="Last message age" value={connection.connectionHealth?.lastMessageAgeMs != null ? `${(connection.connectionHealth.lastMessageAgeMs / 1000).toFixed(1)}s` : null} />
        </div>
        {connection.service && connection.service !== 'rithmic_v2.trading' && (
          <div style={{ marginTop: 8, color: '#facc15', fontSize: 12 }}>⚠ Service is not "rithmic_v2.trading" — verify this is the account you expect before arming.</div>
        )}
      </Card>

      <Card title="Contract Being Traded">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="Order Symbol" value={contract.orderSymbol} />
          <Field label="Contract Code" value={contract.contractCode} />
          <Field label="Expiry Year" value={contract.year} />
        </div>
      </Card>

      <Card title="Trading Control">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <StatusDot state={armed ? 'LIVE' : 'DISCONNECTED'} />
          <span style={{ fontSize: 16, fontWeight: 600, color: armed ? '#4ade80' : '#f87171' }}>{armed ? 'ARMED — placing real orders' : 'HALTED — no new entries'}</span>
        </div>
        {!armed && connection.killSwitch?.haltedReason && (
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>Halted: {connection.killSwitch.haltedReason} ({connection.killSwitch.haltedBy})</div>
        )}
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={doStart} disabled={busy || armed} style={{ padding: '10px 20px', background: armed ? '#334155' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: armed ? 'default' : 'pointer', fontWeight: 600 }}>Start</button>
          <button onClick={doStop} disabled={busy || !armed} style={{ padding: '10px 20px', background: !armed ? '#334155' : '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: !armed ? 'default' : 'pointer', fontWeight: 600 }}>Stop</button>
        </div>
        {actionReport && (
          <pre style={{ marginTop: 12, fontSize: 11, color: actionReport.error || (actionReport.data && actionReport.data.verified === false) ? '#f87171' : '#94a3b8', background: '#0f172a', padding: 12, borderRadius: 6, overflowX: 'auto', maxHeight: 240 }}>
            {actionReport.error || JSON.stringify(actionReport.data, null, 2)}
          </pre>
        )}
      </Card>

      {recon && !recon.clean && (
        <Card title="⚠ Reconciliation Mismatch">
          <div style={{ fontSize: 12, color: '#facc15', marginBottom: 8 }}>Last checked: {recon.checkedAt}</div>
          {recon.unknownToApp?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: '#e2e8f0' }}>{recon.unknownToApp.length} order(s) open at the broker with no record in this app (may be unrelated activity — verify directly in Sierra Chart):</div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>{recon.unknownToApp.map((o) => `${o.Symbol} ${o.ServerOrderID}`).join(', ')}</div>
            </div>
          )}
          {recon.staleInApp?.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#f87171' }}>{recon.staleInApp.length} order(s) this app thinks are open but the broker no longer shows:</div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>{recon.staleInApp.map((o) => `setup_id=${o.setup_id} ${o.client_order_id}`).join(', ')}</div>
            </div>
          )}
        </Card>
      )}

      <Card title="Proposed: broker-side target orders (not built)">
        <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>
          Today targets are watched by the app every 15 seconds and exited at market, so a
          target can be missed or filled late if price passes it between checks. Stops already
          sit at the broker. Proposal: also place each target as a resting limit order at the
          broker, so targets are as reliable as stops. Status: proposal only, nothing built or
          live. Needs your approval before any change to how trades are placed.
        </div>
      </Card>

      {status.unconfirmedCloses !== null && status.unconfirmedCloses?.length > 0 && (
        <Card title={`⚠ Closes Not Confirmed at Broker (${status.unconfirmedCloses.length})`}>
          <div style={{ fontSize: 13, color: '#fca5a5', marginBottom: 8 }}>
            The app shows these trades closed, but the broker has no filled exit or stop for them. Review them in Sierra Chart before trusting the record.
          </div>
          {status.unconfirmedCloses.map(c => (
            <div key={c.setup_id} style={{ fontSize: 13, color: '#e2e8f0', padding: '4px 0' }}>
              setup {c.setup_id} · {c.setup_type} · {c.resolution} · app P&L {c.pnl ?? 'n/a'} · resolved {c.resolved_at}
            </div>
          ))}
        </Card>
      )}

      <ActivityLog />

      <Card title={`Recent Orders (${recentOrders.length})`}>
        {recentOrders.length === 0 ? (
          <div style={{ fontSize: 13, color: '#94a3b8' }}>No real orders placed yet.</div>
        ) : (
          <table style={{ width: '100%', fontSize: 12, color: '#e2e8f0', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#94a3b8', fontSize: 11 }}>
                <th>Setup</th><th>Purpose</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Status</th><th>Filled</th><th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.map((o) => (
                <tr key={o.id} style={{ borderTop: '1px solid #334155' }}>
                  <td>{o.setup_id}</td><td>{o.purpose}</td><td style={{ fontFamily: 'monospace' }}>{o.symbol}</td><td>{o.side}</td><td>{o.quantity}</td>
                  <td style={{ color: o.status === 'REJECTED' || o.status === 'ERROR' ? '#f87171' : o.status === 'FILLED' ? '#4ade80' : '#e2e8f0' }}>{o.status}</td>
                  <td>{o.filled_quantity}</td><td>{o.submitted_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
