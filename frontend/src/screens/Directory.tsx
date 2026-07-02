// F1 — employee directory (port of directory.js). Search + filters + keyset
// pagination, all server-side. Site scope and directory access are enforced by
// the API (RLS + the HTTP-layer deny guard); the screen renders what it is
// allowed to see. AC: DIR search/paginate; 403 → explained no-access state.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Button, Input, NoAccess, ErrorPanel, Loading, Select } from '../components/ui';

interface Filters { q: string; dept: string; status: string }

export default function Directory() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>({ q: '', dept: '', status: '' });

  const query = useInfiniteQuery({
    queryKey: ['directory', filters],
    queryFn: ({ pageParam }) => api.directory({ ...filters, limit: 50, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    retry: false,
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setFilters({ q: String(f.get('q') ?? ''), dept: String(f.get('dept') ?? ''), status: String(f.get('status') ?? '') });
  }

  if (query.isError) {
    return isApiError(query.error) && query.error.status === 403
      ? <NoAccess title="Directory" message={t('directory.noAccess')} />
      : <ErrorPanel message={t('directory.error')} />;
  }

  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div data-state={query.isPending ? 'loading' : 'ready'}>
      <form onSubmit={submit} className="flex flex-wrap gap-2 mb-3">
        <Input name="q" placeholder={t('directory.search')} />
        <Input name="dept" placeholder={t('directory.department')} />
        <Select name="status" defaultValue="">
          <option value="">{t('directory.anyStatus')}</option>
          <option>active</option><option>suspended</option><option>terminated</option><option>rehire</option>
        </Select>
        <Button type="submit">{t('directory.submit')}</Button>
      </form>
      {query.isPending ? <Loading /> : (
        <>
          <table className="w-full border-collapse bg-surface-raised border border-line rounded-card">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="p-2">{t('directory.empNo')}</th>
                <th className="p-2">{t('directory.name')}</th>
                <th className="p-2">{t('directory.dept')}</th>
                <th className="p-2">{t('directory.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer border-b border-line hover:bg-surface"
                    onClick={() => navigate(`/directory/${r.id}`)}>
                  <td className="p-2">{r.emp_no ?? ''}</td>
                  <td className="p-2">{r.full_name}</td>
                  <td className="p-2">{r.dept ?? ''}</td>
                  <td className="p-2">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.hasNextPage && (
            <Button className="mt-3" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {t('directory.loadMore')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
