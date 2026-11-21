import type { Principal } from './auth.js';
import { escapeHtml as e } from './http.js';
import { getUser, type PublicUser } from './store.js';

const STYLES = `
  body{font-family:system-ui,sans-serif;margin:0;color:#1f2933;background:#f5f7fa}
  header{display:flex;gap:1rem;align-items:center;justify-content:space-between;padding:.75rem 1.5rem;background:#243b53;color:#fff}
  header form{margin:0} nav{display:flex;gap:1rem;padding:.5rem 1.5rem;background:#d9e2ec}
  main{padding:1.5rem;max-width:960px} table{border-collapse:collapse;width:100%;background:#fff}
  th,td{border:1px solid #bcccdc;padding:.4rem .6rem;text-align:left}
  [role=alert]{color:#9b1c1c;background:#fde8e8;padding:.5rem;border-radius:4px}
  [role=status]{color:#03543f} .card{background:#fff;padding:1rem;border-radius:6px;margin:.5rem 0}
  [role=dialog]{position:fixed;top:15%;left:50%;transform:translateX(-50%);background:#fff;padding:1.5rem;
    border:1px solid #829ab1;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.25);min-width:320px}
  label{display:block;margin-top:.5rem} input,select{padding:.3rem;min-width:240px}`;

export function layout(title: string, body: string, principal?: Principal): string {
  const user = principal?.userId ? getUser(principal.userId) : undefined;
  const displayName = user ? `${user.firstName} ${user.lastName}` : (principal?.subject ?? '');
  const chrome = principal
    ? `<header>
        <strong>Demo Admin Portal</strong>
        <div>
          <span data-testid="current-user">${e(displayName)}</span>
          (<span data-testid="current-role">${e(principal.role)}</span>)
        </div>
        <form method="post" action="/logout"><button type="submit">Sign out</button></form>
      </header>
      <nav aria-label="Main">
        <a href="/dashboard">Dashboard</a><a href="/users">Users</a><a href="/search">Search</a>
      </nav>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${e(title)} | Demo Admin Portal</title><style>${STYLES}</style></head>
    <body>${chrome}<main>${body}</main></body></html>`;
}

export function loginView(error?: string, username = '', next = '/dashboard'): string {
  return layout(
    'Sign in',
    `<h1>Sign in</h1>
     ${error ? `<div role="alert">${e(error)}</div>` : ''}
     <form method="post" action="/login" class="card" novalidate>
       <input type="hidden" name="next" value="${e(next)}">
       <label for="username">Username</label>
       <input id="username" name="username" type="email" autocomplete="username" value="${e(username)}">
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="current-password">
       <p><button type="submit">Sign in</button></p>
     </form>
     <p>No account? <a href="/register">Create an account</a></p>`,
  );
}

export function dashboardView(principal: Principal, totalUsers: number): string {
  const user = principal.userId ? getUser(principal.userId) : undefined;
  return layout(
    'Dashboard',
    `<h1>Dashboard</h1>
     <p data-testid="welcome-message">Welcome, ${e(user ? `${user.firstName} ${user.lastName}` : principal.subject)}</p>
     <section aria-label="Statistics" class="card">
       <h2>Statistics</h2>
       <p>Total users: <strong data-testid="stat-total-users">${totalUsers}</strong></p>
     </section>
     <p>
       <button type="button" id="show-announcement">Show announcement</button>
       <a href="/release-notes" target="_blank" rel="noopener">Open release notes</a>
     </p>
     <div role="dialog" aria-modal="true" aria-labelledby="announcement-title" id="announcement" hidden>
       <h2 id="announcement-title">Announcement</h2>
       <p>Scheduled maintenance this Saturday 02:00-04:00 UTC.</p>
       <button type="button" id="ack">Acknowledge</button>
     </div>
     <iframe title="Help widget" src="/widgets/help" width="420" height="160"></iframe>
     <script>
       const dlg = document.getElementById('announcement');
       document.getElementById('show-announcement').addEventListener('click', () => { dlg.hidden = false; });
       document.getElementById('ack').addEventListener('click', () => { dlg.hidden = true; });
     </script>`,
    principal,
  );
}

export function helpWidgetView(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Help</title></head><body>
    <h2>Help Center</h2>
    <button type="button" id="contact">Contact support</button>
    <p role="status" id="support-status"></p>
    <script>document.getElementById('contact').addEventListener('click', () => {
      document.getElementById('support-status').textContent = 'Support request sent';
    });</script></body></html>`;
}

export function releaseNotesView(principal?: Principal): string {
  return layout(
    'Release notes',
    `<h1>Release Notes</h1><ul><li>1.4.0 - User import/export</li><li>1.3.0 - Role based access</li></ul>`,
    principal,
  );
}

function userRow(user: PublicUser, canEdit: boolean, canRemove: boolean): string {
  const name = `${user.firstName} ${user.lastName}`;
  const payload = e(JSON.stringify(user));
  return `<tr data-testid="user-row-${e(user.id)}" data-user="${payload}">
    <td>${e(name)}</td><td>${e(user.email)}</td><td>${e(user.role)}</td><td>${e(user.status)}</td>
    <td>
      ${canEdit ? `<button type="button" class="edit" aria-label="Edit ${e(name)}">Edit</button>` : ''}
      ${canRemove ? `<button type="button" class="delete" aria-label="Delete ${e(name)}">Delete</button>` : ''}
    </td></tr>`;
}

export function usersView(
  principal: Principal,
  users: PublicUser[],
  filter: string,
  flags: { canEdit: boolean; canDelete: boolean },
): string {
  const rows = users.map((u) => userRow(u, flags.canEdit, flags.canDelete)).join('');
  return layout(
    'Users',
    `<h1>User Management</h1>
     <form role="search" method="get" action="/users">
       <label for="q">Filter users</label>
       <input id="q" name="q" type="search" value="${e(filter)}">
       <button type="submit">Apply filter</button>
     </form>
     <p role="status" id="users-status"></p>
     ${
       users.length === 0
         ? '<p data-testid="empty-state">No users found</p>'
         : `<table aria-label="Users"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
     }
     <p><a href="/users/export.csv">Export CSV</a></p>
     ${
       flags.canEdit
         ? `<form id="import-form" class="card">
              <label for="import-file">Import users (CSV)</label>
              <input id="import-file" type="file" accept=".csv,text/csv">
              <button type="submit">Upload</button>
            </form>`
         : ''
     }
     <div role="dialog" aria-modal="true" aria-labelledby="edit-title" id="edit-dialog" hidden>
       <h2 id="edit-title">Edit user</h2>
       <div role="alert" id="edit-error" hidden></div>
       <form id="edit-form">
         <input type="hidden" id="edit-id">
         <label for="edit-first">First name</label><input id="edit-first">
         <label for="edit-last">Last name</label><input id="edit-last">
         <label for="edit-role">Role</label>
         <select id="edit-role"><option value="admin">admin</option><option value="editor">editor</option><option value="viewer">viewer</option></select>
         <label for="edit-status">Status</label>
         <select id="edit-status"><option value="active">active</option><option value="inactive">inactive</option></select>
         <p><button type="submit">Save changes</button> <button type="button" id="edit-cancel">Cancel</button></p>
       </form>
     </div>
     <script>
       const dialog = document.getElementById('edit-dialog');
       const status = document.getElementById('users-status');
       const errorBox = document.getElementById('edit-error');
       const field = (id) => document.getElementById(id);
       document.querySelectorAll('button.edit').forEach((btn) => btn.addEventListener('click', () => {
         const user = JSON.parse(btn.closest('tr').dataset.user);
         field('edit-id').value = user.id; field('edit-first').value = user.firstName;
         field('edit-last').value = user.lastName; field('edit-role').value = user.role;
         field('edit-status').value = user.status; errorBox.hidden = true; dialog.hidden = false;
         field('edit-first').focus();
       }));
       field('edit-cancel').addEventListener('click', () => { dialog.hidden = true; });
       field('edit-form').addEventListener('submit', async (event) => {
         event.preventDefault();
         const response = await fetch('/api/users/' + encodeURIComponent(field('edit-id').value), {
           method: 'PATCH', headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ firstName: field('edit-first').value, lastName: field('edit-last').value,
             role: field('edit-role').value, status: field('edit-status').value }) });
         if (!response.ok) {
           const body = await response.json();
           errorBox.textContent = (body.error.details || []).map((d) => d.field + ': ' + d.message).join('; ') || body.error.message;
           errorBox.hidden = false; return;
         }
         sessionStorage.setItem('flash', 'User updated'); location.reload();
       });
       document.querySelectorAll('button.delete').forEach((btn) => btn.addEventListener('click', async () => {
         const user = JSON.parse(btn.closest('tr').dataset.user);
         if (!confirm('Delete ' + user.firstName + ' ' + user.lastName + '?')) { status.textContent = 'Deletion cancelled'; return; }
         const response = await fetch('/api/users/' + encodeURIComponent(user.id), { method: 'DELETE' });
         if (response.ok) { sessionStorage.setItem('flash', 'User deleted'); location.reload(); }
         else { status.textContent = 'Delete failed'; }
       }));
       const importForm = document.getElementById('import-form');
       if (importForm) importForm.addEventListener('submit', async (event) => {
         event.preventDefault();
         const file = field('import-file').files[0];
         if (!file) { status.textContent = 'Choose a CSV file first'; return; }
         const response = await fetch('/users/import', { method: 'POST',
           headers: { 'Content-Type': 'text/csv' }, body: await file.text() });
         const body = await response.json();
         status.textContent = response.ok ? 'Imported ' + body.imported + ' users' : 'Import failed: ' + body.error.message;
       });
       const flash = sessionStorage.getItem('flash');
       if (flash) { status.textContent = flash; sessionStorage.removeItem('flash'); }
     </script>`,
    principal,
  );
}

export function userDetailView(principal: Principal, user: PublicUser): string {
  return layout(
    `${user.firstName} ${user.lastName}`,
    `<h1>${e(user.firstName)} ${e(user.lastName)}</h1>
     <dl class="card">
       <dt>Email</dt><dd data-testid="user-email">${e(user.email)}</dd>
       <dt>Role</dt><dd data-testid="user-role">${e(user.role)}</dd>
       <dt>Status</dt><dd data-testid="user-status">${e(user.status)}</dd>
     </dl>
     <p><a href="/users">Back to users</a></p>`,
    principal,
  );
}

export function searchView(principal: Principal, term: string, results: PublicUser[] | undefined): string {
  const list =
    results === undefined
      ? ''
      : `<p data-testid="result-count">${results.length} ${results.length === 1 ? 'result' : 'results'}</p>
         <ul aria-label="Search results">${results
           .map(
             (u) =>
               `<li><a href="/users/${e(u.id)}">${e(u.firstName)} ${e(u.lastName)}</a> - <span>${e(u.email)}</span></li>`,
           )
           .join('')}</ul>`;
  return layout(
    'Search',
    `<h1>Search</h1>
     <form role="search" method="get" action="/search">
       <label for="term">Search</label>
       <input id="term" name="term" type="search" value="${e(term)}" placeholder="Name or e-mail">
       <button type="submit">Search</button>
     </form>${list}`,
    principal,
  );
}

export const COUNTRIES = ['India', 'Germany', 'United Kingdom', 'United States'] as const;

export function registerView(errors: string[] = [], values: Record<string, string> = {}): string {
  const v = (key: string) => e(values[key] ?? '');
  return layout(
    'Register',
    `<h1>Create an account</h1>
     ${
       errors.length > 0
         ? `<ul role="alert" aria-label="Form errors">${errors.map((x) => `<li>${e(x)}</li>`).join('')}</ul>`
         : ''
     }
     <form method="post" action="/register" class="card" novalidate>
       <label for="firstName">First name</label><input id="firstName" name="firstName" value="${v('firstName')}">
       <label for="lastName">Last name</label><input id="lastName" name="lastName" value="${v('lastName')}">
       <label for="email">Email</label><input id="email" name="email" type="email" value="${v('email')}">
       <label for="password">Password</label><input id="password" name="password" type="password">
       <label for="confirmPassword">Confirm password</label><input id="confirmPassword" name="confirmPassword" type="password">
       <label for="country">Country</label>
       <select id="country" name="country"><option value="">Select a country</option>${COUNTRIES.map(
         (c) => `<option value="${e(c)}"${values.country === c ? ' selected' : ''}>${e(c)}</option>`,
       ).join('')}</select>
       <label><input type="checkbox" name="terms" value="yes"> I accept the terms and conditions</label>
       <p><button type="submit">Create account</button></p>
     </form>`,
  );
}

export function registrationSuccessView(email: string): string {
  return layout(
    'Registered',
    `<h1>Registration successful</h1>
     <p>Account created for <span data-testid="registered-email">${e(email)}</span>.</p>
     <p><a href="/login">Sign in</a></p>`,
  );
}

export function notFoundView(principal?: Principal): string {
  return layout('Not found', '<h1>Page not found</h1>', principal);
}
