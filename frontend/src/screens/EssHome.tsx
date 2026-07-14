// E2 — ESS services home (UNI-01, A3, PRT-01), COMPLETED (ESS-3, Kira
// 2026-07-14). The mobile shell: status-safe topbar with the online/offline
// chip, greeting, quick-action grid and REAL data — leave balance and the
// latest published payslip come from certified own-only endpoints. Of the 8
// design quick-actions, six have backends and render (Leave, Payslip, My
// KPIs, Policies, Support + the functional Clock-in tile); Documents (E5),
// Training (Slice 13) and ID card (E11) have NO backend and are deliberately
// ABSENT, never mocked — they stay on the deferred list.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, session } from '../lib/api';
import { Skeleton } from '../components/state';
import { initials } from '../components/shell';
import { IcBanknote, IcCalendar, IcChart, IcFile, IcLifeBuoy, IcLogOut, IcMapPin } from '../components/icons';

export default function EssHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const landing = useQuery({ queryKey: ['landing'], queryFn: api.landing, retry: false });
  const balance = useQuery({ queryKey: ['leaveBalance'], queryFn: api.leaveBalance, retry: false });
  const payslips = useQuery({ queryKey: ['payslips'], queryFn: api.myPayslips, retry: false });
  if (landing.isError) { session.clear(); navigate('/login'); return null; }

  const name = landing.data?.name ?? '';
  const QA = [
    { label: t('ess.qaLeave'), icon: <IcCalendar />, to: '/ess/leave' },
    { label: t('ess.qaPayslip'), icon: <IcBanknote />, to: '/ess/payslip' },
    { label: t('attendance.clockin'), icon: <IcMapPin />, to: '/ess/clockin' },
    { label: t('ess.qaPerf'), icon: <IcChart />, to: '/ess/kpis' },
    { label: t('ess.qaPolicies'), icon: <IcFile />, to: '/policy' },
    { label: t('ess.qaSupport'), icon: <IcLifeBuoy />, to: '/support' },
  ];
  const latest = payslips.data?.periods?.[0];
  const annual = balance.data?.annual;

  return (
    <div className="ess" style={{ minHeight: '100vh' }} data-state={landing.isPending ? 'loading' : 'populated'}>
      <div className="topbar">
        <div>
          <div className="tt">{t('ess.home')}</div>
          <div className="ts">{t('ess.homeSub')}</div>
        </div>
        <span className={`net${online ? '' : ' off'}`}>{online ? t('ess.online') : t('ess.offline')}</span>
        <button className="iconbtn" style={{ width: 32, height: 32 }} onClick={() => { api.logout(); queryClient.clear(); navigate('/login'); }}>
          <IcLogOut style={{ width: 15, height: 15 }} />
        </button>
      </div>
      <div className="body">
        {landing.isPending ? <Skeleton rows={4} /> : (
          <>
            <div className="shiftbar">
              <span className="av">{initials(name || '·')}</span>
              <div>
                <div className="nm">{t('ess.greet')} {name}</div>
                <div className="mt">{landing.data?.role}</div>
              </div>
            </div>

            <div className="shead">{t('ess.quick')}</div>
            <div className="qagrid">
              {QA.map((q) => (
                <button key={q.to} className="qa" onClick={() => navigate(q.to)}>
                  {q.icon}
                  <span>{q.label}</span>
                </button>
              ))}
            </div>

            <div className="shead">{t('ess.activity')}</div>
            <div className="plist">
              {annual && (
                <div className="pitem">
                  <div style={{ flex: 1 }}><div className="pt">{t('ess.homeLeaveLine')}</div>
                    <div className="pd">{t('ess.homeLeaveSub')}</div></div>
                  <span className="ptime num">{annual.available}/{annual.entitlement}</span>
                </div>
              )}
              {latest ? (
                <div className="pitem">
                  <div style={{ flex: 1 }}><div className="pt">{t('ess.homePayLine')}</div>
                    <div className="pd">{latest.period ?? '—'}</div></div>
                  <span className="ptime num">TZS {latest.net_pay.toLocaleString('en-US')}</span>
                </div>
              ) : (
                <div className="pitem">
                  <div style={{ flex: 1 }}><div className="pt">{t('ess.payslip.emptyT')}</div>
                    <div className="pd">{t('ess.payslip.emptyB')}</div></div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
