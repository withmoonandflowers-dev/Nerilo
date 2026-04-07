/**
 * Connection Status Panel
 * Displays connection count, topology type, per-peer latency & quality.
 */

import React from 'react';
import type { PeerLatencyInfo, ConnectionQuality } from '../core/mesh/HeartbeatService';

interface ConnectionStatusPanelProps {
  peers: PeerLatencyInfo[];
  topologyStrategy: string;
  participantCount: number;
}

const QUALITY_COLORS: Record<ConnectionQuality, string> = {
  excellent: '#4caf50',
  good: '#8bc34a',
  fair: '#ff9800',
  poor: '#f44336',
};

export const ConnectionStatusPanel: React.FC<ConnectionStatusPanelProps> = ({
  peers,
  topologyStrategy,
  participantCount,
}) => {
  const reachableCount = peers.filter((p) => p.reachable).length;

  return (
    <div style={{ padding: '8px', fontSize: '12px', fontFamily: 'monospace' }}>
      <div style={{ marginBottom: '4px' }}>
        <strong>Connections:</strong> {reachableCount}/{participantCount - 1} peers
        {' | '}
        <strong>Topology:</strong> {topologyStrategy}
      </div>

      {peers.length > 0 && (
        <div>
          {peers.map((peer) => (
            <div
              key={peer.peerId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '2px 0',
              }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: peer.reachable
                    ? QUALITY_COLORS[peer.quality]
                    : '#666',
                  display: 'inline-block',
                }}
              />
              <span style={{ minWidth: '80px' }}>
                {peer.peerId.slice(0, 8)}
              </span>
              <span style={{ color: QUALITY_COLORS[peer.quality] }}>
                {peer.rttMs !== null ? `${peer.rttMs}ms` : '---'}
              </span>
              <span style={{ color: '#999', fontSize: '10px' }}>
                {peer.quality}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
