// Login (port of the scaffold's showLogin). Password + mandatory TOTP; a 401
// is reported as authentication failure with no hint at which factor failed.
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Button, Input, Msg } from '../components/ui';

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { message?: string } };
  const [message, setMessage] = useState<string | null>(location.state?.message ?? null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api.login(
        String(form.get('email') ?? '').trim(),
        String(form.get('password') ?? ''),
        String(form.get('mfa') ?? '').trim(),
      );
      navigate('/');
    } catch (err) {
      setMessage(isApiError(err) && err.status === 401 ? t('login.failed') : t('login.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-xs mx-auto mt-16 grid gap-2.5" data-state="login">
      <h1 className="text-2xl font-bold">HCMOS</h1>
      <Msg kind="blocked">{message}</Msg>
      <form onSubmit={submit} className="grid gap-2.5">
        <Input name="email" type="email" placeholder={t('login.email')} autoComplete="username" required />
        <Input name="password" type="password" placeholder={t('login.password')} autoComplete="current-password" required />
        <Input name="mfa" inputMode="numeric" placeholder={t('login.mfa')} required />
        <Button type="submit" disabled={busy}>{t('login.submit')}</Button>
      </form>
    </section>
  );
}
