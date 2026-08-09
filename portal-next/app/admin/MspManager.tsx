'use client';
import { useState } from 'react';
import type { Msp, Tenant } from '@/lib/server/tenant-store';

interface Props {
  msps: Msp[];
  tenants: Tenant[];
}

export default function AdminMspManager({ msps, tenants }: Props) {
  const [expandedMsp, setExpandedMsp] = useState<string | null>(msps[0]?.slug ?? null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* MSP list */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: '0.9rem', fontWeight: 600 }}>Managed Service Providers</h2>
        <a href="/admin/msps/new" className="btn btn-sm">+ New MSP</a>
      </div>

      {msps.length === 0 ? (
        <div className="card empty-state">
          <p>No MSPs configured yet.</p>
          <a href="/admin/msps/new" className="btn" style={{ marginTop: 12, display: 'inline-flex' }}>Create first MSP</a>
        </div>
      ) : msps.map(msp => {
        const mspTenants = tenants.filter(t => t.mspId === msp.id);
        const expanded   = expandedMsp === msp.slug;
        return (
          <div key={msp.slug} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setExpandedMsp(expanded ? null : msp.slug)}
            >
              <div>
                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{msp.displayName}</span>
                <span style={{ color: 'var(--muted)', fontSize: '0.75rem', marginLeft: 10 }}>{msp.giteaOrg} · {mspTenants.length} tenant{mspTenants.length !== 1 ? 's' : ''}</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <a href={`/msps/${msp.slug}`} className="btn btn-ghost btn-sm" onClick={e => e.stopPropagation()}>Open ↗</a>
                <a href={`/admin/msps/${msp.slug}/edit`} className="btn btn-ghost btn-sm" onClick={e => e.stopPropagation()}>Edit</a>
                <span style={{ color: 'var(--muted)' }}>{expanded ? '▲' : '▼'}</span>
              </div>
            </div>

            {expanded && (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px 8px' }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tenants</span>
                  <a href={`/admin/tenants/new?mspId=${msp.id}`} className="btn btn-ghost btn-sm">+ Add Tenant</a>
                </div>
                {mspTenants.length === 0 ? (
                  <div className="empty-state" style={{ padding: '20px 20px 24px' }}>No tenants yet.</div>
                ) : (
                  <div className="tbl-wrap" style={{ margin: '0 20px 20px', borderRadius: 8 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Slug</th>
                          <th>Domain</th>
                          <th>Status</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {mspTenants.map(t => (
                          <tr key={t.slug}>
                            <td>{t.displayName}</td>
                            <td><code style={{ fontSize: '0.78rem' }}>{t.slug}</code></td>
                            <td style={{ color: 'var(--muted)' }}>{t.domain ?? '—'}</td>
                            <td><span className={`badge badge-${t.isActive ? 'success' : 'neutral'}`}>{t.isActive ? 'Active' : 'Inactive'}</span></td>
                            <td style={{ textAlign: 'right' }}>
                              <a href={`/admin/tenants/${t.slug}/edit`} className="btn btn-ghost btn-sm">Edit</a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
