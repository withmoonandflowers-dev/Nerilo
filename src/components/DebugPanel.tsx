/**
 * Debug Panel
 * Only displayed when window.__NERILO_DEBUG__ = true
 *
 * Tabs:
 * 1. Mesh Topology Graph — SVG visualization of peers and connections
 * 2. Gossip Traces — recent message paths
 * 3. Delivery Stats — send/receive/dedup counters and latencies
 * 4. Channel Metrics — per-channel buffered amount, rates, backpressure
 */

import React, { useState, useEffect } from 'react';
import { metricsCollector } from '../core/metrics/MetricsCollector';
import type {
  DeliveryStats,
  GossipTrace,
  ChannelMetrics,
} from '../core/metrics/MetricsCollector';

declare global {
  interface Window {
    __NERILO_DEBUG__?: boolean;
  }
}

type TabName = 'topology' | 'gossip' | 'delivery' | 'channels';

export const DebugPanel: React.FC = () => {
  const [isEnabled, setIsEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState<TabName>('topology');
  const [stats, setStats] = useState<DeliveryStats | null>(null);
  const [traces, setTraces] = useState<GossipTrace[]>([]);
  const [channels, setChannels] = useState<ChannelMetrics[]>([]);

  useEffect(() => {
    setIsEnabled(!!window.__NERILO_DEBUG__);
  }, []);

  useEffect(() => {
    if (!isEnabled) return;

    const interval = setInterval(() => {
      setStats(metricsCollector.getDeliveryStats());
      setTraces(metricsCollector.getGossipTraces());
      setChannels(metricsCollector.getChannelMetrics());
    }, 2000);

    return () => clearInterval(interval);
  }, [isEnabled]);

  if (!isEnabled) return null;

  const tabStyle = (tab: TabName) => ({
    padding: '4px 12px',
    border: 'none',
    borderBottom: activeTab === tab ? '2px solid #4fc3f7' : '2px solid transparent',
    background: 'transparent',
    color: activeTab === tab ? '#4fc3f7' : '#aaa',
    cursor: 'pointer' as const,
    fontSize: '12px',
  });

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        right: 0,
        width: '400px',
        maxHeight: '300px',
        background: '#1a1a2e',
        color: '#e0e0e0',
        fontSize: '11px',
        fontFamily: 'monospace',
        zIndex: 9999,
        borderTopLeftRadius: '8px',
        overflow: 'auto',
        boxShadow: '0 -2px 10px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ display: 'flex', borderBottom: '1px solid #333', padding: '4px' }}>
        <button style={tabStyle('topology')} onClick={() => setActiveTab('topology')}>
          Topology
        </button>
        <button style={tabStyle('gossip')} onClick={() => setActiveTab('gossip')}>
          Gossip
        </button>
        <button style={tabStyle('delivery')} onClick={() => setActiveTab('delivery')}>
          Delivery
        </button>
        <button style={tabStyle('channels')} onClick={() => setActiveTab('channels')}>
          Channels
        </button>
      </div>

      <div style={{ padding: '8px' }}>
        {activeTab === 'delivery' && stats && (
          <div>
            <div>Sent: {stats.sent} | Received: {stats.received} | Dedup: {stats.deduplicated}</div>
            <div>Reachability: {stats.reachabilityPercent}%</div>
            <div>Avg Latency: {stats.avgLatencyMs}ms | P99: {stats.p99LatencyMs}ms</div>
            <div>Backpressure events: {metricsCollector.getBackpressureCount()}</div>
          </div>
        )}

        {activeTab === 'gossip' && (
          <div>
            {traces.length === 0 ? (
              <div style={{ color: '#666' }}>No gossip traces yet</div>
            ) : (
              traces.slice(-10).reverse().map((t, i) => (
                <div key={i} style={{ marginBottom: '4px', borderBottom: '1px solid #333', paddingBottom: '2px' }}>
                  <div>ID: {t.messageId.slice(0, 12)}...</div>
                  <div>Path: {t.path.join(' → ')} ({t.hopCount} hops, {t.totalLatencyMs}ms)</div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'channels' && (
          <div>
            {channels.length === 0 ? (
              <div style={{ color: '#666' }}>No channel data</div>
            ) : (
              channels.map((ch, i) => (
                <div key={i} style={{ marginBottom: '4px' }}>
                  <div>
                    {ch.peerId.slice(0, 8)}:{ch.kind} — buf:{ch.bufferedAmount}B
                    {' '}| {ch.messagesPerSecond} msg/s | {Math.round(ch.bytesPerSecond / 1024)}KB/s
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'topology' && (
          <div style={{ color: '#666' }}>
            Topology visualization (connect peers to see graph)
          </div>
        )}
      </div>
    </div>
  );
};
