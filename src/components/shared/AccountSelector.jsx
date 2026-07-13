import React from 'react';

export default function AccountSelector({ accounts, selectedAccounts, setSelectedAccounts }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {accounts.map(acct => (
        <button key={acct}
          onClick={() => {
            if (selectedAccounts.includes(acct)) {
              if (selectedAccounts.length > 1) setSelectedAccounts(prev => prev.filter(a => a !== acct));
            } else {
              setSelectedAccounts(prev => [...prev, acct]);
            }
          }}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            background: selectedAccounts.includes(acct) ? '#3b82f6' : 'var(--card-bg)',
            color: selectedAccounts.includes(acct) ? '#fff' : 'var(--text-muted)',
            border: `1px solid ${selectedAccounts.includes(acct) ? '#3b82f6' : 'var(--border-color)'}`,
          }}>
          {acct.slice(-8)}
        </button>
      ))}
    </div>
  );
}
