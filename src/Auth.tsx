import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { LogOut, Users, X } from 'lucide-react';

interface User { id: string; email: string; role: string }
interface Team { users: User[]; invites: { email: string; expires: number }[] }
const AuthContext = createContext<User | null>(null);
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '요청을 완료하지 못했습니다.');
  return result;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ required: boolean; user: User | null }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(() => location.hash.startsWith('#invite=') ? location.hash.slice(8) : '');
  useEffect(() => { call<{ required: boolean; user: User | null }>('me').then(setState).catch(() => setError('서버에 연결하지 못했습니다. 잠시 후 새로고침해 주세요.')); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      const result = await call<{ user: User }>(invite ? 'accept-invite' : 'login', 'POST', { email: data.get('email'), password: data.get('password'), token: invite });
      if (invite) history.replaceState(null, '', '/#/');
      setInvite(''); setState({ required: true, user: result.user });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (state && (!state.required || state.user)) return <AuthContext.Provider value={state.user}>{children}</AuthContext.Provider>;
  return <main className="auth-screen"><section className="auth-card">
    <div className="brand">FRAME<span>WRITERS’ ROOM</span></div>
    <h1>{invite ? '작업실에 참여하기' : '우리의 다음 이야기가 시작되는 곳'}</h1>
    <p>{invite ? '초대받은 이메일로 비밀번호를 설정해 주세요.' : '초대받은 팀원만 이용할 수 있는 시나리오 작업실입니다.'}</p>
    {!state && !error && <p role="status">작업실을 여는 중…</p>}
    {state && <form onSubmit={submit}>
      <label>이메일<input type="email" name="email" autoComplete="username" required maxLength={254} autoFocus /></label>
      <label>{invite ? '새 비밀번호' : '비밀번호'}<input type="password" name="password" autoComplete={invite ? 'new-password' : 'current-password'} minLength={14} maxLength={256} required /></label>
      {invite && <small>비밀번호는 14자 이상으로 설정해 주세요.</small>}
      <button className="btn primary" disabled={busy}>{busy ? '확인 중…' : invite ? '초대 수락하고 시작하기' : '로그인'}</button>
    </form>}
    {error && <p role="alert" className="auth-error">{error}</p>}
    {invite && <button className="btn" onClick={() => { setInvite(''); history.replaceState(null, '', '/#/'); }}>이미 계정이 있어요</button>}
  </section></main>;
}

export function AccountMenu() {
  const user = useContext(AuthContext);
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState<Team>();
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => setTeam(await call<Team>('team'));
  if (!user) return null;
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await action(async () => {
      const result = await call<{ url: string }>('invites', 'POST', { email: data.get('email') });
      setLink(result.url); form.reset(); await refresh();
    });
  }
  return <div className="account-menu">
    <button className="btn" onClick={() => { setOpen(true); if (user.role === 'admin') void action(refresh); }}><Users size={15} />{user.role === 'admin' ? '팀 관리' : '내 계정'}</button>
    {open && <div className="auth-overlay"><section className="auth-card auth-team" role="dialog" aria-modal="true" aria-labelledby="team-title">
      <button className="btn auth-close" aria-label="닫기" onClick={() => setOpen(false)}><X size={18} /></button>
      <h1 id="team-title">{user.role === 'admin' ? '함께 쓰는 사람들' : '내 계정'}</h1><p>{user.email}</p>
      {user.role === 'admin' && <>
        <form onSubmit={invite}><label>초대할 이메일<input type="email" name="email" required maxLength={254} /></label><button className="btn primary" disabled={busy}>초대 링크 만들기</button></form>
        {link && <div><label>초대 링크<input readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></label><small>48시간 동안 한 번만 사용할 수 있습니다. 해당 팀원에게 링크를 직접 전달해 주세요.</small></div>}
        <ul className="auth-team-list">{team?.users.map((member) => <li key={member.id}><span>{member.email}<small>{member.role === 'admin' ? '관리자' : '팀원'}</small></span>{member.role !== 'admin' && <button className="btn" disabled={busy} onClick={() => { if (confirm(`${member.email}의 작업실 접근 권한을 해제할까요?`)) void action(async () => { await call(`users/${member.id}`, 'DELETE'); await refresh(); }); }}>접근 해제</button>}</li>)}</ul>
        {!!team?.invites.length && <><h2>초대 대기 중</h2><ul className="auth-team-list">{team.invites.map((pending) => <li key={pending.email}><span>{pending.email}</span><button className="btn" disabled={busy} onClick={() => void action(async () => { await call('invites', 'DELETE', { email: pending.email }); setLink(''); await refresh(); })}>초대 취소</button></li>)}</ul></>}
      </>}
      {error && <p role="alert" className="auth-error">{error}</p>}
      <button className="btn" disabled={busy} onClick={() => { if (confirm('저장 상태를 확인하셨나요? 로그아웃합니다.')) void action(async () => { await call('logout', 'POST'); location.reload(); }); }}><LogOut size={15} />로그아웃</button>
    </section></div>}
  </div>;
}
