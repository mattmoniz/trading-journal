import React, { useState, useEffect } from 'react';

export default function DashboardFilters({
  accounts,
  selectedAccounts,
  setSelectedAccounts,
  filters,
  onDateRangeChange,
  onCustomDateChange,
}) {
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);

  useEffect(() => {
    if (!accountDropdownOpen) return;
    const close = (e) => {
      if (!e.target.closest('.account-dropdown')) setAccountDropdownOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [accountDropdownOpen]);

  const toggleAccount = (account) => {
    setSelectedAccounts(prev =>
      prev.includes(account) ? prev.filter(a => a !== account) : [...prev, account]
    );
  };

  return (
    <div className="dashboard-filters">
      <div className="filter-group">
        <label>Date Range:</label>
        <div className="date-range-buttons">
          <button
            className={filters.dateRange === 'all' ? 'active' : ''}
            onClick={() => onDateRangeChange('all')}
          >
            All Time
          </button>
          <button
            className={filters.dateRange === 'today' ? 'active' : ''}
            onClick={() => onDateRangeChange('today')}
          >
            Today
          </button>
          <button
            className={filters.dateRange === 'week' ? 'active' : ''}
            onClick={() => onDateRangeChange('week')}
          >
            Last Week
          </button>
          <button
            className={filters.dateRange === 'month' ? 'active' : ''}
            onClick={() => onDateRangeChange('month')}
          >
            Last Month
          </button>
          <button
            className={filters.dateRange === '3months' ? 'active' : ''}
            onClick={() => onDateRangeChange('3months')}
          >
            Last 3 Months
          </button>
          <button
            className={filters.dateRange === 'custom' ? 'active' : ''}
            onClick={() => onDateRangeChange('custom')}
          >
            Custom Range
          </button>
        </div>

        {filters.dateRange === 'custom' && (
          <div className="custom-date-inputs">
            <div>
              <label>From:</label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => onCustomDateChange('dateFrom', e.target.value)}
              />
            </div>
            <div>
              <label>To:</label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => onCustomDateChange('dateTo', e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      <div className="filter-group account-filter-group">
        <label>Account:</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="account-dropdown">
            <button
              className="account-dropdown-trigger"
              onClick={() => setAccountDropdownOpen(o => !o)}
            >
              {selectedAccounts.length === 0 || selectedAccounts.length === accounts.length
                ? 'All Accounts'
                : selectedAccounts.length === 1
                  ? selectedAccounts[0]
                  : `${selectedAccounts.length} accounts`}
              <span style={{ marginLeft: 6 }}>▾</span>
            </button>
            {accountDropdownOpen && (
              <div className="account-dropdown-menu">
                <label className="account-option">
                  <input
                    type="checkbox"
                    checked={selectedAccounts.length === 0 || selectedAccounts.length === accounts.length}
                    onChange={() => setSelectedAccounts(selectedAccounts.length === accounts.length ? [] : [...accounts])}
                  />
                  All Accounts
                </label>
                {accounts.map(account => (
                  <label key={account} className="account-option">
                    <input
                      type="checkbox"
                      checked={selectedAccounts.includes(account)}
                      onChange={() => toggleAccount(account)}
                    />
                    {account}
                  </label>
                ))}
              </div>
            )}
          </div>
          {selectedAccounts.length > 0 && selectedAccounts.length < accounts.length && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
              <span>{selectedAccounts[0]}</span>
              {selectedAccounts.length > 1 && (
                <>
                  {accountsExpanded && selectedAccounts.slice(1).map(a => (
                    <React.Fragment key={a}>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>|</span>
                      <span>{a}</span>
                    </React.Fragment>
                  ))}
                  <button
                    onClick={() => setAccountsExpanded(e => !e)}
                    style={{ fontSize: 13, fontWeight: 400, color: 'var(--accent-purple)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                  >
                    {accountsExpanded ? '▲ less' : `▼ +${selectedAccounts.length - 1} more`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
