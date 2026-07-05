// C21 — Tenant provisioning wizard (TEN-01/02/03). Step rail Identity …
// Review; every configuration is SEEDED FROM THE REGISTRY server-side (roles,
// matrix, sites/codes, leave & doc types, KPI catalogue, statutory) — no
// manual DB step, so the intermediate steps are review surfaces described by
// the approved wording, and the operator supplies only the tenant identity.
// Atomic result states are DISTINCT: provisioned (fresh RLS-keyed company_id
// + seeded counts + isolation note) vs rolled back (never a half-tenant).
// Identity-collision pre-validation stays a deferred secondary state.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { TenantOut } from '../lib/types';
import { NoPermission, Seal } from '../components/state';
import { IcAlert, IcBuilding, IcCheck, IcFile, IcCalendar, IcChart, IcShield, IcUsers } from '../components/icons';

type Outcome = { ok: true; tenant: TenantOut } | { ok: false; error: string };

const STEPS = ['s_identity', 's_roles', 's_sites', 's_leave', 's_docs', 's_kpi', 's_statutory', 's_review'] as const;

export default function Tenant() {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [noPerm, setNoPerm] = useState(false);

  if (noPerm) return <NoPermission title={t('tenant.noPermTitle')} body={t('tenant.noPermBody')} why={t('tenant.noPermWhy')} />;

  async function provision() {
    setBusy(true);
    try {
      const tenant = await api.provisionTenant(name);
      setOutcome({ ok: true, tenant });
    } catch (err) {
      if (isApiError(err) && err.status === 403) { setNoPerm(true); setBusy(false); return; }
      setOutcome({ ok: false, error: (err instanceof Error && err.message) || t('tenant.rollbackBody') });
    }
    setBusy(false);
    setStep(STEPS.length); // result
  }

  const SEED_TILES: { key: string; icon: JSX.Element }[] = [
    { key: 'tRoles', icon: <IcUsers /> }, { key: 'tMatrix', icon: <IcShield /> },
    { key: 'tSites', icon: <IcBuilding /> }, { key: 'tLeave', icon: <IcCalendar /> },
    { key: 'tDocs', icon: <IcFile /> }, { key: 'tKpi', icon: <IcChart /> },
  ];

  return (
    <div className="grid" style={{ maxWidth: 760 }} data-state={busy ? 'loading' : outcome ? (outcome.ok ? 'success' : 'rolled-back') : `step-${step + 1}`}>
      <div className="wrail">
        {STEPS.map((s, i) => (
          <span key={s} className={`wstep${i < step ? ' done' : i === step ? ' active' : ''}`}>
            <span className="wn">{i < step ? <IcCheck /> : i + 1}</span>{t(`tenant.${s}`)}
          </span>
        ))}
      </div>

      {outcome ? (
        <div className="card card-p">
          {outcome.ok ? (
            <>
              <Seal title={t('tenant.provisionedTitle')} sub={t('tenant.provisionedSub')} />
              <div className="idmint" style={{ marginTop: 12 }}>
                <IcCheck style={{ color: 'var(--green)', width: 18, height: 18 }} />
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{t('tenant.idMintLbl')}</div>
                  <div className="num" style={{ fontWeight: 700 }}>{outcome.tenant.company_id}</div>
                </div>
              </div>
              <div className="seedgrid" style={{ marginTop: 12 }}>
                <div className="seedtile"><span className="si"><IcShield /></span>
                  <span><span className="sl">{t('tenant.seeded')}</span><span className="sc" style={{ display: 'block' }}>{outcome.tenant.config_keys}</span></span>
                  <IcCheck className="sok" /></div>
                <div className="seedtile"><span className="si"><IcBuilding /></span>
                  <span><span className="sl">{t('tenant.tSites')}</span><span className="sc" style={{ display: 'block' }}>{outcome.tenant.sites}</span></span>
                  <IcCheck className="sok" /></div>
              </div>
              <p className="note" style={{ marginTop: 10 }}>{t('tenant.idNote')}</p>
              <button className="btn" style={{ marginTop: 8 }} onClick={() => { setOutcome(null); setStep(0); setName(''); }}>{t('tenant.repeatNote')}</button>
            </>
          ) : (
            <>
              <Seal kind="err" title={t('tenant.rollbackTitle')} sub={t('tenant.rollbackBody')} />
              <p className="muted" style={{ textAlign: 'center' }}>{outcome.error}</p>
              <div style={{ textAlign: 'center' }}>
                <button className="btn" onClick={() => { setOutcome(null); setStep(STEPS.length - 1); }}>{t('tenant.retry')}</button>
              </div>
            </>
          )}
        </div>
      ) : step === 0 ? (
        <form className="card card-p" onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep(1); }}>
          <div className="shead">{t('tenant.idTitle')}</div>
          <div className="fg" style={{ marginTop: 10 }}>
            <div className="field full">
              <label>{t('tenant.idTenant')} <span className="req">*</span></label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          </div>
          <div className="idmint" style={{ marginTop: 8 }}>
            <IcShield style={{ color: 'var(--green)', width: 18, height: 18 }} />
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{t('tenant.idMintLbl')}</div>
              <div className="num">{t('tenant.idMintVal')}</div>
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit">{t('tenant.next')}</button>
          </div>
        </form>
      ) : step < STEPS.length - 1 ? (
        <div className="card card-p">
          <div className="shead">{t(`tenant.${STEPS[step]}`)}</div>
          <span className="regchip" style={{ margin: '8px 0' }}>{t('tenant.rolesSeed')}</span>
          <p className="muted" style={{ fontSize: 12.5 }}>{t('tenant.noManual')}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn" onClick={() => setStep(step - 1)}>{t('tenant.back')}</button>
            <button className="btn primary" onClick={() => setStep(step + 1)}>{t('tenant.next')}</button>
          </div>
        </div>
      ) : (
        <div className="card card-p">
          <div className="shead">{t('tenant.reviewTitle')}</div>
          <p className="muted" style={{ fontSize: 12.5 }}>{t('tenant.reviewNote')}</p>
          <div className="idmint" style={{ margin: '10px 0' }}>
            <IcBuilding style={{ width: 18, height: 18, color: 'var(--green)' }} />
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{t('tenant.idTenant')}</div>
              <div style={{ fontWeight: 700 }}>{name}</div>
            </div>
          </div>
          <div className="seedgrid">
            {SEED_TILES.map((s) => (
              <div className="seedtile" key={s.key}>
                <span className="si">{s.icon}</span>
                <span className="sl">{t(`tenant.${s.key}`)}</span>
                <IcCheck className="sok" />
              </div>
            ))}
          </div>
          {busy && <div className="banner info" style={{ marginTop: 10 }}><IcAlert />{t('tenant.loadingBody')}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setStep(step - 1)} disabled={busy}>{t('tenant.back')}</button>
            <button className="btn primary" onClick={provision} disabled={busy}>{t('tenant.provisionBtn')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
