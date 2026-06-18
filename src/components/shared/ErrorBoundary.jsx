import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', this.props.name || 'unknown', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const { name, compact } = this.props;
      if (compact) {
        return (
          <div style={{
            fontSize: 11, color: '#f87171', padding: '6px 10px',
            border: '1px solid rgba(248,113,113,0.2)', borderRadius: 6,
            background: 'rgba(248,113,113,0.04)',
          }}>
            {name || 'Card'} unavailable — {this.state.error.message}
          </div>
        );
      }
      return (
        <div style={{
          border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8,
          padding: '12px 14px', marginBottom: 16,
          background: 'rgba(248,113,113,0.04)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#f87171', marginBottom: 4 }}>
            {name || 'Card'} — render error
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
