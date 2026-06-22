import React, { useState, useEffect } from 'react';

const API_URL = '/api';

function fmtPts(n) {
  if (n == null) return '—';
  return Math.abs(n).toFixed(2);
}

export default function BehavioralGuideCard() {
  const [data, setData] = useState({
    currentPrice: null,
    priorDayPoc: null,
    priorDayVah: null,
    priorDayVal: null,
    balanceLow: 30695.00, // Fallback Monday Balance
    balanceHigh: 30808.50, // Fallback Monday Balance
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        // Fetch current price & gap context
        const gapRes = await fetch(`${API_URL}/acd/gap-context`);
        const gapData = await gapRes.json();

        // Fetch prior day levels
        const refRes = await fetch(`${API_URL}/auction-read/auto`);
        const refData = await refRes.json();

        // Fetch latest morning brief to extract today's balance area
        const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const briefRes = await fetch(`${API_URL}/morning-brief/${todayET}`);
        let balanceLow = 30695.00;
        let balanceHigh = 30808.50;

        if (briefRes.ok) {
          const briefData = await briefRes.json();
          const text = briefData?.brief_text || '';
          const match = text.match(/between\s*([\d,]+)\s*and\s*([\d,]+)/i) || text.match(/balance.*?([\d,]+)–([\d,]+)/i);
          if (match) {
            balanceLow = parseFloat(match[1].replace(/,/g, ''));
            balanceHigh = parseFloat(match[2].replace(/,/g, ''));
          }
        }

        if (!cancelled) {
          setData({
            currentPrice: gapData.currentPrice || null,
            priorDayPoc: refData.prior_day_poc || null,
            priorDayVah: refData.prior_day_vah || null,
            priorDayVal: refData.prior_day_val || null,
            balanceLow,
            balanceHigh,
            loading: false,
          });
        }
      } catch (err) {
        console.error('Error loading behavioral card data:', err);
        if (!cancelled) {
          setData(prev => ({ ...prev, loading: false }));
        }
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 60000); // Update every minute
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const { currentPrice, priorDayPoc, priorDayVah, priorDayVal, balanceLow, balanceHigh, loading } = data;

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={titleStyle}>Behavioral Level Guide</div>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading metrics...</div>
      </div>
    );
  }

  if (!currentPrice) {
    return (
      <div style={cardStyle}>
        <div style={titleStyle}>Behavioral Level Guide</div>
        <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>Waiting for market print...</div>
      </div>
    );
  }

  // Calculate distances
  const distPoc = priorDayPoc ? currentPrice - priorDayPoc : null;
  const distVah = priorDayVah ? currentPrice - priorDayVah : null;
  const distVal = priorDayVal ? currentPrice - priorDayVal : null;

  // Determine active context card
  let activeCard = null;

  // 1. Check Excursion (Price outside Balance Zone)
  const isAboveBalance = currentPrice > balanceHigh;
  const isBelowBalance = currentPrice < balanceLow;
  const isExcursion = isAboveBalance || isBelowBalance;
  
  if (isExcursion) {
    const excPts = isAboveBalance ? currentPrice - balanceHigh : balanceLow - currentPrice;
    activeCard = {
      type: 'excursion',
      title: '🚀 Balance Zone Excursion',
      status: `Price is ${fmtPts(excPts)} pts ${isAboveBalance ? 'above' : 'below'} balance limits`,
      color: '#f43f5e',
      bg: 'rgba(244, 63, 94, 0.08)',
      border: 'rgba(244, 63, 94, 0.3)',
      guidance: `• Gravitational Pull: 65% return inside within 5 bars; 83% within 15 bars.\n• Average Max Excursion: 29 points before returning.\n• Execution Rule: If price remains outside for >15 bars, this is a real breakout. If not, look to fade back into the zone.`
    };
  }
  // 2. Check VAH Test (within 20 pts of VAH)
  else if (distVah !== null && Math.abs(distVah) <= 20) {
    activeCard = {
      type: 'vah',
      title: '🧪 VAH Edge Test',
      status: `Price is ${fmtPts(distVah)} pts ${distVah >= 0 ? 'above' : 'below'} prior VAH (${priorDayVah})`,
      color: '#fb923c',
      bg: 'rgba(251, 146, 60, 0.08)',
      border: 'rgba(251, 146, 60, 0.3)',
      guidance: `• Churn Expectation: Median 4.8 bars dwell time at VAH with 4.4 retests before resolution.\n• Trapped Shorts: VAH acceleration occurs 48% of the time.\n• Execution Rule: Do not panic sell/buy first touch. Let the levels churn and watch tape for absorption before fading.`
    };
  }
  // 3. Check VAL Test (within 20 pts of VAL)
  else if (distVal !== null && Math.abs(distVal) <= 20) {
    activeCard = {
      type: 'val',
      title: '🛡️ VAL Edge Test',
      status: `Price is ${fmtPts(distVal)} pts ${distVal >= 0 ? 'above' : 'below'} prior VAL (${priorDayVal})`,
      color: '#38bdf8',
      bg: 'rgba(56, 189, 248, 0.08)',
      border: 'rgba(56, 189, 248, 0.3)',
      guidance: `• Churn Expectation: Median 2.1 bars dwell time at VAL with 2.3 retests before resolution.\n• Speed: Support resolves twice as fast as resistance (VAH).\n• Execution Rule: Support levels hold or break decisively. Enter quickly on absorption or cut fast if breached.`
    };
  }
  // 4. Check POC Test (within 25 pts of POC)
  else if (distPoc !== null && Math.abs(distPoc) <= 25) {
    activeCard = {
      type: 'poc',
      title: '🎯 POC Magnet Active',
      status: `Price is ${fmtPts(distPoc)} pts ${distPoc >= 0 ? 'above' : 'below'} prior POC (${priorDayPoc})`,
      color: '#a78bfa',
      bg: 'rgba(167, 139, 250, 0.08)',
      border: 'rgba(167, 139, 250, 0.3)',
      guidance: `• Magnet Effect: Price approaches at 16 pts/bar, dwells only 1.3 bars (touch-and-go).\n• Departure: Decelerates to 7.2 pts/bar upon leaving POC (magnet releases).\n• Execution Rule: POC is a waypoint, not a destination. Use it as a target, NEVER as an entry pivot.`
    };
  }
  // 5. Default Ranging inside Balance
  else {
    activeCard = {
      type: 'neutral',
      title: '⚖️ Ranging In Balance',
      status: `Inside Balance Zone limits (${balanceLow.toFixed(0)} – ${balanceHigh.toFixed(0)})`,
      color: '#10b981',
      bg: 'rgba(16, 185, 129, 0.08)',
      border: 'rgba(16, 185, 129, 0.3)',
      guidance: `• Current Price: ${currentPrice.toLocaleString()}\n• Setup Focus: 80% chance we close inside the active balance zone. Fade extremes, target POC.\n• Overnight trapped inventory dictates the direction of the first edge test.`
    };
  }

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>
        Behavioral Level Guide
      </div>
      
      {activeCard && (
        <div style={{
          padding: '10px 12px',
          borderRadius: 6,
          background: activeCard.bg,
          border: `1.5px dashed ${activeCard.border}`,
          marginBottom: 10
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: activeCard.color }}>
              {activeCard.title}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 600, marginBottom: 8 }}>
            {activeCard.status}
          </div>
          <div style={{ 
            fontSize: 11.5, 
            color: '#94a3b8', 
            lineHeight: 1.6, 
            whiteSpace: 'pre-line',
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            paddingTop: 8
          }}>
            {activeCard.guidance}
          </div>
        </div>
      )}

      {/* Quick Level Reference Summary */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(3, 1fr)', 
        gap: 6, 
        fontSize: '10px', 
        color: '#64748b', 
        borderTop: '1px solid #1e293b', 
        paddingTop: 8 
      }}>
        <div style={{ textAlign: 'center' }}>
          <div>PRIOR VAL</div>
          <div style={{ fontFamily: 'monospace', color: '#38bdf8', fontWeight: 600 }}>
            {priorDayVal ? priorDayVal.toFixed(0) : '—'}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div>PRIOR POC</div>
          <div style={{ fontFamily: 'monospace', color: '#a78bfa', fontWeight: 600 }}>
            {priorDayPoc ? priorDayPoc.toFixed(0) : '—'}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div>PRIOR VAH</div>
          <div style={{ fontFamily: 'monospace', color: '#fb923c', fontWeight: 600 }}>
            {priorDayVah ? priorDayVah.toFixed(0) : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

const cardStyle = {
  border: '1px solid var(--border-color, #334155)',
  borderRadius: 8,
  padding: '12px 14px',
  marginBottom: 16,
  background: 'rgba(255,255,255,0.02)',
};

const titleStyle = {
  fontSize: 12,
  fontWeight: 700,
  color: '#cbd5e1',
  marginBottom: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
