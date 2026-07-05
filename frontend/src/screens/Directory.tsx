// C4 — Employees directory (EMP-02, UNI-02) + C5 — profile drawer (EMP-01/03,
// SOD-03, A3). Site-filter pills + one full-width card holding table.tbl;
// rows carry mini-avatar names, mono TMCL numbers (non-editable, generated),
// lifecycle status tags, and click open the 540px right drawer. Site scoping
// is ENFORCED server-side (RLS + deny guard) — the list is what the role may
// see, never a client filter. "No employees" and "no rows for this search"
// are DISTINCT empties. Confidential profile sections are ABSENT, not masked
// (A3): the drawer renders only the fields the server returned. Edits route
// to maker-checker approval (EMP-03); an SoD refusal is surfaced verbatim.
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError, CONFIDENTIAL_FIELDS } from '../lib/api';
import type { DirectoryRow } from '../lib/types';
import { Skeleton, EmptyState, ErrorBanner, NoPermission, Tag } from '../components/state';
import { initials } from '../components/shell';
import { IcSearch, IcUsers, IcX } from '../components/icons';
import Disciplinary from './Disciplinary';

const STATUS_TONE: Record<string, 'green' | 'yellow' | 'grey' | 'blue'> = {
  active: 'green', suspended: 'yellow', terminated: 'grey', rehire: 'blue',
};
const AVATAR_BG = ['#1FA24A', '#0094D4', '#9A6B00', '#5C6770'];
const EDITABLE = ['phone', 'email', 'dept', 'home_address', 'full_name'];

export default function Directory() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id: openId } = useParams();
  const [filters, setFilters] = useState({ q: '', status: '' });

  const query = useInfiniteQuery({
    queryKey: ['directory', filters],
    queryFn: ({ pageParam }) => api.directory({ ...filters, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: false,
  });

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const searched = filters.q !== '' || filters.status !== '';

  if (query.isError) {
    return isApiError(query.error) && query.error.status === 403
      ? <NoPermission title={t('employees.noPermTitle')} body={t('employees.noPermBody')} why={t('employees.noPermWhy')} />
      : <ErrorBanner text={t('employees.errBody')} onRetry={() => query.refetch()} retryLabel={t('employees.retry')} />;
  }

  return (
    <div className="grid">
      <form className="sitefilter" onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setFilters((prev) => ({ ...prev, q: String(f.get('q') ?? '') }));
      }}>
        <label className="search" style={{ margin: 0 }}>
          <IcSearch />
          <input name="q" placeholder={t('employees.search')} defaultValue={filters.q} />
        </label>
        {['', 'active', 'suspended', 'terminated', 'rehire'].map((s) => (
          <button key={s || 'any'} type="button"
            className={`pill${filters.status === s ? ' on' : ''}`}
            onClick={() => setFilters((prev) => ({ ...prev, status: s }))}>
            {s === '' ? t('employees.dirScopeOrg') : t(`employees.st${s[0].toUpperCase()}${s.slice(1)}`)}
          </button>
        ))}
      </form>

      <div className="card">
        <div className="card-h">
          <h3>{t('employees.directory')}</h3>
          <span className="meta num">{t('employees.dirShown', { count: rows.length, defaultValue: `${rows.length}` })}</span>
        </div>
        {query.isPending ? <div className="card-p"><Skeleton rows={6} /></div> : rows.length === 0 ? (
          searched
            ? <EmptyState title={t('employees.emptyGeneric')} body={t('employees.emptyGenericBody')} icon={<IcSearch />} />
            : <EmptyState title={t('employees.emptyDirTitle')} body={t('employees.emptyDirBody')} icon={<IcUsers />} />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('employees.colName')}</th>
                <th>{t('employees.fNumber')}</th>
                <th>{t('employees.colRole')}</th>
                <th>{t('employees.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => <Row key={r.id} r={r} i={i} onOpen={() => navigate(`/directory/${r.id}`)} />)}
            </tbody>
          </table>
        )}
        <div className="pager">
          <span className="pager-info num">{rows.length}</span>
          <div className="pager-btns">
            {query.hasNextPage && (
              <button className="btn sm" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {t('employees.largeTitle', { defaultValue: 'Load more' })}
              </button>
            )}
          </div>
        </div>
      </div>

      {openId && <ProfileDrawer id={openId} onClose={() => navigate('/directory')} />}
    </div>
  );
}

function Row({ r, i, onOpen }: { r: DirectoryRow; i: number; onOpen: () => void }) {
  return (
    <tr className="clickable" onClick={onOpen}>
      <td><span className="rowname">
        <span className="ma" style={{ background: AVATAR_BG[i % AVATAR_BG.length] }}>{initials(r.full_name)}</span>
        <span className="name">{r.full_name}</span>
      </span></td>
      <td className="num">{r.emp_no ?? ''}</td>
      <td className="muted">{r.dept ?? ''}</td>
      <td><Tag tone={STATUS_TONE[r.status] ?? 'grey'}>{r.status}</Tag></td>
    </tr>
  );
}

// C5 — the profile drawer. Sections render ONLY what the server returned:
// a role without entitlement gets no confidential section at all (A3).
function ProfileDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [showDisc, setShowDisc] = useState(false);

  const emp = useQuery({ queryKey: ['employee', id], queryFn: () => api.employee(id), retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['employee', id] });

  const change = useMutation({
    mutationFn: (v: { field: string; value: string }) => api.requestChange(id, v.field, v.value),
    onSuccess: () => { setMessage(null); refresh(); },
    onError: (err) => setMessage(isApiError(err) && err.status === 403 ? t('disciplinary.forbidBody') : t('employees.errBody')),
  });
  const approve = useMutation({
    mutationFn: (changeId: string) => api.approveChange(changeId),
    onSuccess: () => { setMessage(null); refresh(); },
    onError: (err) => setMessage(isApiError(err) && err.status === 403 ? t('disciplinary.sodClashSelf') : t('employees.errBody')),
  });

  const data = emp.data ?? {};
  const conf = new Set<string>(CONFIDENTIAL_FIELDS);
  const entries = Object.entries(data).filter(([k, v]) => k !== 'pending_changes' && v != null && typeof v !== 'object');
  const identity = entries.filter(([k]) => !conf.has(k));
  const confidential = entries.filter(([k]) => conf.has(k));
  const pending = (emp.data?.pending_changes ?? []);
  const name = String(data.full_name ?? '');
  const status = String(data.status ?? '');

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer-panel">
        <div className="prof" data-state={emp.isPending ? 'loading' : emp.isError ? 'error' : 'populated'}>
          {emp.isPending ? <div style={{ padding: 24 }}><Skeleton rows={8} /></div> : emp.isError ? (
            <div style={{ padding: 24 }}>
              <ErrorBanner text={isApiError(emp.error) && emp.error.status === 404 ? t('employees.noPermBody') : t('employees.errBody')} onRetry={() => emp.refetch()} />
            </div>
          ) : showDisc ? (
            <div style={{ padding: 20, overflowY: 'auto' }}>
              <Disciplinary employeeId={id} onDone={() => { setShowDisc(false); refresh(); }} />
            </div>
          ) : (
            <>
              <div className="prof-head">
                <div className="prof-id">
                  <span className="ma" style={{ width: 52, height: 52, fontSize: 17, background: '#1FA24A' }}>{initials(name)}</span>
                  <div className="prof-id-txt">
                    <div className="prof-name">{name}</div>
                    <div className="prof-role">{String(data.dept ?? '')}</div>
                  </div>
                  <button className="iconbtn prof-x" onClick={onClose}><IcX /></button>
                </div>
                <div className="prof-chips">
                  {data.emp_no != null && <span className="pchip"><span className="k">{t('employees.fNumber')}</span><span className="v">{String(data.emp_no)}</span></span>}
                  {status && (
                    <span className={`pchip status-${STATUS_TONE[status] ?? 'green'}`}>
                      <span className="dot" /><span className="v rot">{status}</span>
                    </span>
                  )}
                </div>
                <div className="prof-actions">
                  <button className="btn danger" onClick={() => setShowDisc(true)}>{t('disciplinary.discTitle')}</button>
                </div>
              </div>
              <div className="prof-body">
                <ProfSection title={t('employees.tabOverview')} fields={identity} />
                {confidential.length > 0 && (
                  <div className="prof-sec">
                    <div className="prof-sh">{t('employees.tabConfidential')}<span className="prof-note">{t('employees.confShown')}</span></div>
                    <div className="prof-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      {confidential.map(([k, v]) => (
                        <div key={k}><div className="prof-fl">{k}</div><div className="prof-fv num">{String(v)}</div></div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="prof-sec">
                  <div className="prof-sh">{t('employees.editReq')}</div>
                  <form className="fg" onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    change.mutate({ field: String(f.get('field')), value: String(f.get('value') ?? '') });
                  }}>
                    <div className="field"><label>{t('employees.edit')}</label>
                      <select name="field">{EDITABLE.map((x) => <option key={x}>{x}</option>)}</select></div>
                    <div className="field"><label>{t('employees.na')}</label>
                      <input name="value" placeholder={t('employees.edit')} /></div>
                    <div className="full">
                      <button className="btn primary sm" type="submit" disabled={change.isPending}>{t('employees.save')}</button>
                    </div>
                  </form>
                  {pending.length > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {pending.map((c) => (
                        <div key={c.id} className="prof-doc">
                          <span className="num">{c.field}</span>
                          <span className="muted">{c.before} → {c.after}</span>
                          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => approve.mutate(c.id)} disabled={approve.isPending}>
                            {t('leave.approveBtn')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {message && <div className="banner err" style={{ marginTop: 10 }} role="alert">{message}</div>}
                  <div className="prof-secured">{t('employees.confAbsent')}</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function ProfSection({ title, fields }: { title: string; fields: [string, unknown][] }) {
  if (fields.length === 0) return null;
  return (
    <div className="prof-sec">
      <div className="prof-sh">{title}</div>
      <div className="prof-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {fields.map(([k, v]) => (
          <div key={k}>
            <div className="prof-fl">{k}</div>
            <div className={`prof-fv${k === 'emp_no' ? ' num' : ''}`}>{String(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
