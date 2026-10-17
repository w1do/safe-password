import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { installFakeBackend } from './fakeBackend';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSignedIn(setup?: (b: ReturnType<typeof installFakeBackend>) => void) {
  const backend = installFakeBackend({ signedIn: true });
  setup?.(backend);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: /Создать проект/ });
  return { backend, user };
}

describe('login', () => {
  it('requires email, password and token and shows errors', async () => {
    const backend = installFakeBackend();
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Email'), backend.creds.email);
    await user.type(screen.getByLabelText('Пароль'), backend.creds.password);
    await user.type(screen.getByLabelText('Токен доступа'), 'vlt_wrong');
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный email, пароль или токен доступа');

    await user.clear(screen.getByLabelText('Токен доступа'));
    await user.type(screen.getByLabelText('Токен доступа'), backend.creds.token);
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('button', { name: /Создать проект/ })).toBeInTheDocument();

    const login = backend.requests.find((r) => r.path === '/api/auth/login' && r.body?.token === backend.creds.token)!;
    expect(login.body).toEqual({ email: backend.creds.email, password: backend.creds.password, token: backend.creds.token });
    expect(login.headers['X-Vault-Request']).toBe('1');
  });
});

describe('dashboard', () => {
  it('creates a project and adds several credentials with hidden secrets', async () => {
    const { backend, user } = await renderSignedIn();

    await user.click(screen.getByRole('button', { name: /Создать проект/ }));
    await user.type(screen.getByLabelText('Название'), 'CRM');
    await user.click(screen.getByRole('button', { name: 'Создать' }));
    expect(await screen.findByRole('heading', { name: 'CRM' })).toBeInTheDocument();

    for (const [service, name, secret] of [
      ['GitHub', 'Production API', 'ghp_secret_one'],
      ['GitLab', 'Mirror', 'glpat_secret_two'],
    ]) {
      await user.click(screen.getByRole('button', { name: /Добавить доступ/ }));
      await user.type(screen.getByLabelText('Сервис'), service);
      await user.type(screen.getByLabelText('Название ключа'), name);
      await user.type(screen.getByLabelText('Секрет'), secret);
      await user.click(screen.getByRole('button', { name: 'Добавить' }));
      await screen.findByRole('cell', { name: service });
    }

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    for (const value of screen.getAllByTestId('secret-value')) expect(value).toHaveTextContent('••••');
    expect(document.body.textContent).not.toContain('ghp_secret_one');
    // List responses never contain secrets.
    const lists = backend.responses.filter((r) => r.path.endsWith('/credentials'));
    expect(lists.length).toBeGreaterThan(0);
    for (const r of lists) expect(r.text).not.toMatch(/secret_(one|two)/);
  });

  it('reveals and copies one specific secret on demand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { backend, user } = await renderSignedIn((b) => {
      const p = b.seedProject('CRM');
      b.seedCredential(p, 'GitHub', 'Prod', 'ghp_visible');
      b.seedCredential(p, 'Server', 'root', 'root_password');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const row = (await screen.findByRole('cell', { name: 'GitHub' })).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Показать секрет' }));
    expect(await within(row).findByText('ghp_visible')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('root_password');

    await user.click(within(row).getByRole('button', { name: 'Копировать секрет' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ghp_visible'));
    expect(backend.requests.filter((r) => r.path.endsWith('/secret'))).toHaveLength(1);

    await user.click(within(row).getByRole('button', { name: 'Скрыть секрет' }));
    expect(within(row).getByTestId('secret-value')).toHaveTextContent('••••');
  });

  it('keeps the previous secret when the edit form leaves it empty', async () => {
    const { backend, user } = await renderSignedIn((b) => {
      const p = b.seedProject('CRM');
      b.seedCredential(p, 'GitHub', 'Prod', 'keep_me');
    });

    await user.click(await screen.findByRole('button', { name: 'Изменить Prod' }));
    const name = screen.getByLabelText('Название ключа');
    await user.clear(name);
    await user.type(name, 'Production');
    expect(screen.getByLabelText('Секрет')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await screen.findByText('Production');
    const patch = backend.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toEqual({ service: 'GitHub', name: 'Production', status: 'active' });
    expect(backend.credentials[0].secret).toBe('keep_me');
  });

  it('changes status and deletes only inactive records after confirmation', async () => {
    const { backend, user } = await renderSignedIn((b) => {
      const p = b.seedProject('CRM');
      b.seedCredential(p, 'GitHub', 'old', 's1', 'inactive');
      b.seedCredential(p, 'GitHub', 'current', 's2');
      b.seedCredential(p, 'GitLab', 'legacy', 's3');
    });

    await user.click(await screen.findByRole('switch', { name: 'Статус legacy' }));
    await waitFor(() => expect(backend.credentials.find((c) => c.name === 'legacy')!.status).toBe('inactive'));

    const bulk = await screen.findByRole('button', { name: /Удалить неактивные \(2\)/ });
    await user.click(bulk);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Активные записи не затрагиваются');
    expect(backend.requests.some((r) => r.path.endsWith('/inactive'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Удалить неактивные' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    expect(backend.credentials.map((c) => c.name)).toEqual(['current']);
  });

  it('deletes a single record after confirmation', async () => {
    const { backend, user } = await renderSignedIn((b) => {
      const p = b.seedProject('CRM');
      b.seedCredential(p, 'GitHub', 'a', 's1');
      b.seedCredential(p, 'GitHub', 'b', 's2');
    });
    await user.click(await screen.findByRole('button', { name: 'Удалить a' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(backend.credentials.map((c) => c.name)).toEqual(['b']));
  });

  it('renames a project', async () => {
    const { user } = await renderSignedIn((b) => b.seedProject('Shop'));
    await user.click(await screen.findByRole('button', { name: 'Переименовать Shop' }));
    const input = screen.getByLabelText('Название');
    await user.clear(input);
    await user.type(input, 'Магазин');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('heading', { name: 'Магазин' })).toBeInTheDocument();
  });

  it('searches across projects by project, service and key name', async () => {
    const { user } = await renderSignedIn((b) => {
      const crm = b.seedProject('CRM');
      const site = b.seedProject('Личный сайт');
      b.seedCredential(crm, 'GitHub', 'Production API', 'x');
      b.seedCredential(site, 'Хостинг', 'FTP', 'y');
    });
    await screen.findByRole('cell', { name: 'GitHub' });
    await user.type(screen.getByRole('searchbox', { name: 'Поиск' }), 'сайт');
    expect(await screen.findByRole('heading', { name: 'Результаты поиска' })).toBeInTheDocument();
    expect(await screen.findByRole('cell', { name: 'Хостинг' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'GitHub' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Проект' })).toBeInTheDocument();
  });

  it('rotates the token, shows it once and returns to the login screen', async () => {
    const { backend, user } = await renderSignedIn();
    await user.click(screen.getByRole('button', { name: /Сменить токен/ }));
    await user.type(screen.getByLabelText('Текущий пароль'), backend.creds.password);
    await user.click(screen.getByRole('button', { name: 'Сменить токен' }));

    expect(await screen.findByTestId('new-token')).toHaveTextContent('vlt_new_token_value');
    await user.click(screen.getByRole('button', { name: 'Я сохранил токен' }));
    expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument();
    expect(screen.queryByTestId('new-token')).not.toBeInTheDocument();
  });
});
