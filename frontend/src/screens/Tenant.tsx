// F8 — tenant provisioning wizard (port of tenant.js, C21). Per-step flow:
//   1. details — the tenant name (companyId is minted server-side; codes are
//      registry-minted, so the operator never picks an id).
//   2. review  — confirm what will be seeded FROM THE REGISTRY (config + sites).
//   3. result  — provisioned (new company_id, seeded counts) OR the atomic-
//      rollback state (a mid-provision fault → nothing half-created).
// Deferred (Design state #4): pre-provision validation of code/name collision
// and currency/country combos — conscious deferral; the atomic-rollback net IS
// built and is a DISTINCT result state. The endpoint 403s any non-platform-
// admin role.
import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { TenantOut } from '../lib/types';
import { Button, GhostButton, Input, Panel } from '../components/ui';

type Outcome = { ok: true; tenant: TenantOut } | { ok: false; error: string };

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const { t } = useTranslation();
  const labels = [t('tenant.step.details'), t('tenant.step.review'), t('tenant.step.result')];
  return (
    <ol className="flex gap-4 list-none p-0 mb-3">
      {labels.map((label, i) => (
        <li key={label} className={i + 1 === step ? 'font-bold text-brand' : 'text-ink-muted'}>
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

// Pure result view — provisioned vs rolled-back are DISTINCT states (spec #4 net).
export function ProvisionResult({ outcome }: { outcome: Outcome }) {
  const { t } = useTranslation();
  if (outcome.ok) {
    const tn = outcome.tenant;
    return (
      <div data-state="provisioned" className="border border-line rounded-card p-3 bg-surface-raised">
        <h4 className="font-semibold text-ok">{t('tenant.provisioned')}</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 my-2">
          <dt className="font-semibold">{t('tenant.companyId')}</dt><dd>{tn.company_id}</dd>
          <dt className="font-semibold">{t('tenant.nameLabel')}</dt><dd>{tn.name}</dd>
          <dt className="font-semibold">{t('tenant.configSeeded')}</dt><dd>{t('tenant.keys', { n: tn.config_keys })}</dd>
          <dt className="font-semibold">{t('tenant.sites')}</dt><dd>{tn.sites}</dd>
        </dl>
        <p className="text-ink-muted">{t('tenant.isolated')}</p>
      </div>
    );
  }
  // Atomic-rollback state: the whole tenant rolled back; nothing half-created.
  return (
    <div data-state="rolled-back" className="border border-danger rounded-card p-3 bg-surface-raised">
      <h4 className="font-semibold text-danger">{t('tenant.rolledBack')}</h4>
      <p>{t('tenant.rolledBackText')}</p>
      <p className="text-ink-muted">{outcome.error || t('tenant.retry')}</p>
    </div>
  );
}

export default function Tenant() {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function provision() {
    setBusy(true);
    let out: Outcome;
    try { out = { ok: true, tenant: await api.provisionTenant(name) }; }
    catch (err) {
      out = {
        ok: false,
        error: isApiError(err) && err.status === 403
          ? t('tenant.notPermitted')
          : (err instanceof Error && err.message) || t('tenant.failed'),
      };
    }
    setBusy(false);
    setOutcome(out);
    setStep(3);
  }

  return (
    <Panel title={t('tenant.title')} state={`step-${step}`}>
      <Stepper step={step} />
      {step === 1 && (
        <form
          className="flex gap-2 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const v = String(new FormData(e.currentTarget).get('name') ?? '').trim();
            if (!v) return;
            setName(v);
            setStep(2);
          }}
        >
          <label className="grid gap-1">
            {t('tenant.name')}
            <Input name="name" defaultValue={name} required />
          </label>
          <Button type="submit">{t('tenant.next')}</Button>
        </form>
      )}
      {step === 2 && (
        <div>
          <p>
            <Trans i18nKey="tenant.reviewText" values={{ name }} components={{ 1: <strong /> }} />
          </p>
          <p className="text-ink-muted">{t('tenant.rollbackNote')}</p>
          <div className="flex gap-2 mt-3">
            <GhostButton onClick={() => setStep(1)}>{t('tenant.back')}</GhostButton>
            <Button onClick={provision} disabled={busy}>{t('tenant.go')}</Button>
          </div>
        </div>
      )}
      {step === 3 && outcome && (
        <div>
          <ProvisionResult outcome={outcome} />
          <GhostButton className="mt-3" onClick={() => { setStep(1); setName(''); setOutcome(null); }}>
            {t('tenant.again')}
          </GhostButton>
        </div>
      )}
    </Panel>
  );
}
