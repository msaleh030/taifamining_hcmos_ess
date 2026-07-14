// E6 — ESS payslip (ESS-3/ESS-4, PRT-02). The one surface every worker opens.
// Composed ONLY from the certified own-only endpoints (/me/payslips,
// /me/payslip) — no employee parameter exists, so this can never show anyone
// else's pay. WORDING IS LAW (design E6 + Kira 2026-07-14): the gross figure
// reads "Total Pay" — never "Total Allowance" — and Net Pay = Total Pay −
// Total Deduction. The underlying net identity (Total Allowances − Total
// Deductions + Cent Round Up − Cent Round Down, contract v2.0) is enforced at
// ingest (EXACT-07); this screen renders the published figures, it never
// recomputes money.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Skeleton } from '../components/state';
import { IcAlert, IcBanknote, IcChevronL, IcFile } from '../components/icons';

const tzs = (n: number) => `TZS ${n.toLocaleString('en-US')}`;

export default function Payslip() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [batch, setBatch] = useState<string | undefined>(undefined);

  const list = useQuery({ queryKey: ['payslips'], queryFn: api.myPayslips, retry: false });
  const slip = useQuery({ queryKey: ['payslip', batch ?? 'latest'], queryFn: () => api.myPayslip(batch), retry: false });

  const body = () => {
    if (list.isPending || slip.isPending) return <Skeleton rows={5} />;
    if (list.isError || slip.isError) {
      return (
        <div className="lock" style={{ minHeight: '50vh' }}>
          <span className="ic"><IcAlert style={{ width: 22, height: 22 }} /></span>
          <h3>{t('ess.errT')}</h3><p>{t('ess.errB')}</p>
        </div>
      );
    }
    const p = slip.data?.payslip ?? null;
    if (!p) {
      return (
        <div className="lock" style={{ minHeight: '50vh' }}>
          <span className="ic"><IcFile style={{ width: 22, height: 22 }} /></span>
          <h3>{t('ess.payslip.emptyT')}</h3><p>{t('ess.payslip.emptyB')}</p>
        </div>
      );
    }
    const periods = list.data?.periods ?? [];
    return (
      <>
        {periods.length > 1 && (
          <div className="shead">{t('ess.payslip.periods')}</div>
        )}
        {periods.length > 1 && (
          <div className="pick" style={{ maxHeight: 130, marginBottom: 10 }}>
            {periods.map((pp) => (
              <button key={pp.batch_id} className={`inp${pp.batch_id === p.batch_id ? ' on' : ''}`}
                style={{ justifyContent: 'space-between', display: 'flex', cursor: 'pointer' }}
                onClick={() => setBatch(pp.batch_id)}>
                <span>{pp.period ?? '—'}</span>
                <span className="num">{tzs(pp.net_pay)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="shiftbar">
          <div>
            <div className="nm">{p.employee.full_name}</div>
            <div className="mt">{p.employee.emp_no ?? '—'} · {p.period ?? '—'}</div>
          </div>
        </div>
        <div className="shead">{t('ess.payslip.earnings')}</div>
        <div className="plist">
          {p.earnings.map((it) => (
            <div key={it.label} className="pitem">
              <div style={{ flex: 1 }}><div className="pt">{it.label}</div></div>
              <span className="ptime num">{tzs(it.amount)}</span>
            </div>
          ))}
        </div>
        <div className="shead">{t('ess.payslip.deductions')}</div>
        <div className="plist">
          {p.deductions.map((it) => (
            <div key={it.label} className="pitem">
              <div style={{ flex: 1 }}><div className="pt">{it.label}</div></div>
              <span className="ptime num">{tzs(it.amount)}</span>
            </div>
          ))}
        </div>
        <div className="shead">{t('ess.payslip.totals')}</div>
        <div className="plist">
          <div className="pitem">
            <div style={{ flex: 1 }}><div className="pt">{t('ess.payslip.totalPay')}</div></div>
            <span className="ptime num">{tzs(p.totals.total_pay)}</span>
          </div>
          <div className="pitem">
            <div style={{ flex: 1 }}><div className="pt">{t('ess.payslip.totalDeduction')}</div></div>
            <span className="ptime num">−{tzs(p.totals.total_deduction)}</span>
          </div>
          <div className="pitem" style={{ fontWeight: 700 }}>
            <div style={{ flex: 1 }}><div className="pt">{t('ess.payslip.netPay')}</div></div>
            <span className="ptime num">{tzs(p.totals.net_pay)}</span>
          </div>
        </div>
        <div className="note" style={{ marginTop: 8 }}>{t('ess.payslip.identity')}</div>
      </>
    );
  };

  return (
    <div className="ess" style={{ minHeight: '100vh' }}>
      <div className="topbar">
        <button className="iconbtn" style={{ width: 32, height: 32 }} onClick={() => navigate('/ess')}>
          <IcChevronL style={{ width: 15, height: 15 }} />
        </button>
        <div>
          <div className="tt">{t('ess.payslip.title')}</div>
          <div className="ts">{t('ess.payslip.sub')}</div>
        </div>
        <span style={{ marginLeft: 'auto' }}><IcBanknote style={{ width: 16, height: 16 }} /></span>
      </div>
      <div className="body">{body()}</div>
    </div>
  );
}
