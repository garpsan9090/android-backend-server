const appContent = document.getElementById('app-content');

let adminToken = localStorage.getItem('adminToken') || '';
let currentView = 'login';
let currentAuthView = 'login'; // 'login', 'signup', '2fa', '2fa-setup'
let pending2faAdminId = '';
let currentTransactionStatus = 'all';
let currentPendingTab = 'deposit';
let currentUsersPage = 1;
let currentUsersSearch = '';
let currentUsersFilter = 'all';
let currentUsersData = [];
let currentAdminId = localStorage.getItem('adminId') || '';
const REFRESH_INTERVAL = 30000;
let autoRefreshTimer = null;
const PAGE_SIZE = 8;

function apiUrl(path) {
  const configuredBase = String(window.__ADMIN_API_BASE_URL || '').trim();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (configuredBase) {
    return `${configuredBase.replace(/\/$/, '')}${normalizedPath}`;
  }
  if (window.location.protocol === 'file:') {
    return `https://upward-investments-backend-server.onrender.com${normalizedPath}`;
  }
  return normalizedPath;
}

function fetchWithAuth(url, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
  return fetch(apiUrl(url), Object.assign({}, opts, { headers }));
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return { status: response.status };
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: text.replace(/<[^>]*>/g, '').trim() || `Request failed (${response.status})`,
      status: response.status,
      rawText: text,
    };
  }
}

function createToast(message, type = 'success') {
  const host = appContent.querySelector('.toasts') || document.createElement('div');
  if (!host.classList.contains('toasts')) {
    host.className = 'toasts';
    appContent.prepend(host);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  host.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function showAlert(message, type = 'error') {
  const alertsHost = appContent.querySelector('.alerts') || document.createElement('div');
  if (!alertsHost.classList.contains('alerts')) {
    alertsHost.className = 'alerts';
    appContent.prepend(alertsHost);
  }

  alertsHost.innerHTML = '';
  const alert = document.createElement('div');
  alert.className = `alert ${type === 'ok' ? 'ok' : ''}`.trim();
  alert.textContent = message;
  alertsHost.appendChild(alert);
  setTimeout(() => alert.remove(), 6000);
}

function clearAlert() {
  const alert = appContent.querySelector('.alerts');
  if (alert) alert.innerHTML = '';
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatCurrency(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN')}`;
}

function setTheme(theme) {
  const isLight = theme === 'light';
  document.body.classList.toggle('light-theme', isLight);
  localStorage.setItem('adminTheme', theme);
}

function getInitialTheme() {
  return localStorage.getItem('adminTheme') || 'dark';
}

function renderLogin() {
  currentView = 'login';
  
  if (currentAuthView === '2fa') {
    renderTwoFactorVerify();
  } else if (currentAuthView === '2fa-setup') {
    renderTwoFactorSetup();
  } else if (currentAuthView === 'signup') {
    renderSignup();
  } else if (currentAuthView === 'reset') {
    renderReset();
  } else {
    renderLoginForm();
  }
}

function renderLoginForm() {
  appContent.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-badge">SECURE ADMIN ACCESS</div>
        <h1>Sign in to the finance control center</h1>
        <p>Manage approvals, users, balances, and payment configuration with a premium admin experience.</p>
        <div class="input-group">
          <label for="admin-username">Username</label>
          <input id="admin-username" type="text" placeholder="admin" />
        </div>
        <div class="input-group">
          <label for="admin-password">Password</label>
          <input id="admin-password" type="password" placeholder="••••••••" />
        </div>
        <button class="button full" id="admin-login-btn">Sign in</button>
        <p style="text-align: center; margin-top: 16px; font-size: 14px;">
          <button id="toggle-reset-btn" class="button secondary" style="padding: 0; border: none; background: none; color: #1e88e5; text-decoration: underline; cursor: pointer; font-size: 14px;">Forgot password?</button>
        </p>
        <p style="text-align: center; margin-top: 16px; font-size: 14px;">
          New here? <button id="toggle-signup-btn" class="button secondary" style="padding: 0; border: none; background: none; color: #1e88e5; text-decoration: underline; cursor: pointer; font-size: 14px;">Create account</button>
        </p>
      </div>
    </div>
  `;

  document.getElementById('admin-login-btn').addEventListener('click', async () => {
    const username = document.getElementById('admin-username').value.trim();
    const password = document.getElementById('admin-password').value.trim();
    if (!username || !password) return showAlert('Enter username and password');

    try {
      const response = await fetch(apiUrl('/api/admin/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data.error || 'Auth failed');
      
      if (data.requires2fa) {
        pending2faAdminId = data.adminId || '';
        currentAdminId = data.adminId || currentAdminId;
        if (currentAdminId) localStorage.setItem('adminId', currentAdminId);
        currentAuthView = '2fa';
        renderLogin();
      } else {
        adminToken = data.token;
        currentAdminId = data.admin?.id || data.adminId || currentAdminId;
        localStorage.setItem('adminToken', adminToken);
        if (currentAdminId) localStorage.setItem('adminId', currentAdminId);
        currentAuthView = 'login';
        renderApp();
        createToast('Welcome back, admin.', 'success');
      }
    } catch (err) {
      showAlert(err.message || 'Login failed');
    }
  });

  document.getElementById('toggle-reset-btn').addEventListener('click', () => {
    currentAuthView = 'reset';
    renderLogin();
  });

  document.getElementById('toggle-signup-btn').addEventListener('click', () => {
    currentAuthView = 'signup';
    renderLogin();
  });
}

function renderSignup() {
  appContent.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-badge">CREATE ADMIN ACCOUNT</div>
        <h1>Set up your admin account</h1>
        <p>Create an account to manage the finance control center.</p>
        <div class="input-group">
          <label for="signup-username">Username</label>
          <input id="signup-username" type="text" placeholder="admin" />
        </div>
        <div class="input-group">
          <label for="signup-password">Password</label>
          <input id="signup-password" type="password" placeholder="••••••••" />
        </div>
        <div class="input-group">
          <label for="signup-confirm">Confirm Password</label>
          <input id="signup-confirm" type="password" placeholder="••••••••" />
        </div>
        <div class="input-group">
          <label for="signup-secret-key">Admin secret key</label>
          <input id="signup-secret-key" type="password" placeholder="Enter the admin secret key" />
        </div>
        <button class="button full" id="admin-signup-btn">Create Account</button>
        <p style="text-align: center; margin-top: 16px; font-size: 14px;">
          Already have an account? <button id="toggle-login-btn" class="button secondary" style="padding: 0; border: none; background: none; color: #1e88e5; text-decoration: underline; cursor: pointer; font-size: 14px;">Sign in</button>
        </p>
      </div>
    </div>
  `;

  document.getElementById('admin-signup-btn').addEventListener('click', async () => {
    const username = document.getElementById('signup-username').value.trim();
    const password = document.getElementById('signup-password').value.trim();
    const confirm = document.getElementById('signup-confirm').value.trim();
    const creationKey = document.getElementById('signup-secret-key').value.trim();
    
    if (!username || !password) return showAlert('Enter username and password');
    if (password !== confirm) return showAlert('Passwords do not match');
    if (password.length < 6) return showAlert('Password must be at least 6 characters');
    if (!creationKey) return showAlert('Enter the admin secret key');

    try {
      const response = await fetch(apiUrl('/api/admin/signup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, creationKey }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data.error || 'Signup failed');

      renderSignupSuccess(data.secretKey);
    } catch (err) {
      showAlert(err.message || 'Signup failed');
    }
  });

  document.getElementById('toggle-login-btn').addEventListener('click', () => {
    currentAuthView = 'login';
    renderLogin();
  });
}

function renderSignupSuccess(secretKey) {
  appContent.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-badge">ADMIN CREATED</div>
        <h1>Admin account created</h1>
        <p>Copy this admin secret key and keep it safe. You will need it for admin signup and reset.</p>
        <div class="input-group">
          <label for="created-secret-key">Admin Secret Key</label>
          <input id="created-secret-key" type="text" readonly value="${secretKey}" />
        </div>
        <button class="button full" id="copy-secret-key-btn">Copy key</button>
        <p style="text-align: center; margin-top: 16px; font-size: 14px;">
          <button id="signup-success-login-btn" class="button secondary" style="padding: 0; border: none; background: none; color: #1e88e5; text-decoration: underline; cursor: pointer; font-size: 14px;">Back to login</button>
        </p>
      </div>
    </div>
  `;

  document.getElementById('copy-secret-key-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(secretKey);
      showAlert('Secret key copied to clipboard.', 'ok');
    } catch (err) {
      showAlert('Unable to copy key. Copy it manually.', 'ok');
    }
  });

  document.getElementById('signup-success-login-btn').addEventListener('click', () => {
    currentAuthView = 'login';
    renderLogin();
  });
}

function renderReset() {
  appContent.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-badge">RESET ADMIN PASSWORD</div>
        <h1>Reset admin credentials</h1>
        <p>Enter your admin username, the secret key, and a new password.</p>
        <div class="input-group">
          <label for="reset-username">Username</label>
          <input id="reset-username" type="text" placeholder="admin" />
        </div>
        <div class="input-group">
          <label for="reset-password">New password</label>
          <input id="reset-password" type="password" placeholder="••••••••" />
        </div>
        <div class="input-group">
          <label for="reset-confirm">Confirm new password</label>
          <input id="reset-confirm" type="password" placeholder="••••••••" />
        </div>
        <div class="input-group">
          <label for="reset-secret-key">Admin secret key</label>
          <input id="reset-secret-key" type="password" placeholder="Enter the admin secret key" />
        </div>
        <button class="button full" id="admin-reset-btn">Reset Password</button>
        <p style="text-align: center; margin-top: 16px; font-size: 14px;">
          <button id="reset-back-btn" class="button secondary" style="padding: 0; border: none; background: none; color: #1e88e5; text-decoration: underline; cursor: pointer; font-size: 14px;">Back to login</button>
        </p>
      </div>
    </div>
  `;

  document.getElementById('admin-reset-btn').addEventListener('click', async () => {
    const username = document.getElementById('reset-username').value.trim();
    const password = document.getElementById('reset-password').value.trim();
    const confirm = document.getElementById('reset-confirm').value.trim();
    const secretKey = document.getElementById('reset-secret-key').value.trim();

    if (!username || !password || !secretKey) return showAlert('Enter username, new password, and secret key');
    if (password !== confirm) return showAlert('Passwords do not match');
    if (password.length < 6) return showAlert('Password must be at least 6 characters');

    try {
      const response = await fetch(apiUrl('/api/admin/password-reset'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, secretKey }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data.error || 'Password reset failed');

      showAlert(data.message || 'Password reset successful', 'ok');
      setTimeout(() => {
        currentAuthView = 'login';
        renderLogin();
      }, 2500);
    } catch (err) {
      showAlert(err.message || 'Password reset failed');
    }
  });

  document.getElementById('reset-back-btn').addEventListener('click', () => {
    currentAuthView = 'login';
    renderLogin();
  });
}

function renderTwoFactorVerify() {
  appContent.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-badge">VERIFY IDENTITY</div>
        <h1>Two-factor authentication</h1>
        <p>Enter the 6-digit code from your authenticator app.</p>
        <div class="input-group">
          <label for="2fa-code">Verification Code</label>
          <input id="2fa-code" type="text" inputmode="numeric" placeholder="000000" maxlength="6" />
        </div>
        <button class="button full" id="verify-2fa-btn">Verify</button>
        <p style="text-align: center; margin-top: 16px; font-size: 14px;">
          <button id="2fa-back-btn" class="button secondary" style="padding: 0; border: none; background: none; color: #1e88e5; text-decoration: underline; cursor: pointer; font-size: 14px;">Back to login</button>
        </p>
      </div>
    </div>
  `;

  document.getElementById('verify-2fa-btn').addEventListener('click', async () => {
    const code = document.getElementById('2fa-code').value.trim();
    if (!code || code.length !== 6) return showAlert('Enter valid 6-digit code');

    try {
      const response = await fetch(apiUrl('/api/admin/2fa/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: pending2faAdminId, code }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data.error || 'Verification failed');
      
      adminToken = data.token;
      currentAdminId = data.admin?.id || data.adminId || pending2faAdminId || currentAdminId;
      localStorage.setItem('adminToken', adminToken);
      if (currentAdminId) localStorage.setItem('adminId', currentAdminId);
      pending2faAdminId = '';
      currentAuthView = 'login';
      renderApp();
      createToast('Welcome back, admin.', 'success');
    } catch (err) {
      showAlert(err.message || 'Verification failed');
    }
  });

  document.getElementById('2fa-back-btn').addEventListener('click', () => {
    pending2faAdminId = '';
    currentAuthView = 'login';
    renderLogin();
  });
}

function renderTwoFactorSetup() {
  appContent.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-badge">SETUP 2FA</div>
        <h1>Enable two-factor authentication</h1>
        <p>Scan the QR code with your authenticator app and verify the code.</p>
        <div id="qr-container" style="text-align: center; margin: 20px 0; padding: 20px; background: #f5f5f5; border-radius: 8px;">
          Loading QR code...
        </div>
        <div class="input-group">
          <label for="setup-code">Verification Code</label>
          <input id="setup-code" type="text" inputmode="numeric" placeholder="000000" maxlength="6" />
        </div>
        <button class="button full" id="enable-2fa-btn">Enable 2FA</button>
      </div>
    </div>
  `;

  loadQRCode();

  document.getElementById('enable-2fa-btn').addEventListener('click', async () => {
    const code = document.getElementById('setup-code').value.trim();
    if (!code || code.length !== 6) return showAlert('Enter valid 6-digit code');

    try {
      const secret = document.getElementById('qr-container').getAttribute('data-secret');
      const response = await fetch(apiUrl('/api/admin/2fa/enable'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: pending2faAdminId, code, secret }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data.error || 'Failed to enable 2FA');
      
      showAlert('2FA enabled successfully', 'ok');
      setTimeout(() => {
        pending2faAdminId = '';
        currentAuthView = 'login';
        renderLogin();
      }, 2000);
    } catch (err) {
      showAlert(err.message || 'Failed to enable 2FA');
    }
  });
}

async function loadQRCode() {
  try {
    const response = await fetch(apiUrl('/api/admin/2fa/setup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: pending2faAdminId }),
    });
    const data = await readResponse(response);
    if (!response.ok) throw new Error(data.error || 'Failed to setup 2FA');

    const container = document.getElementById('qr-container');
    container.setAttribute('data-secret', data.secret);
    
    const qrCodeScript = document.createElement('script');
    qrCodeScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    qrCodeScript.onload = () => {
      container.innerHTML = '';
      new QRCode(container, {
        text: data.otpauthUrl,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
      const secretDiv = document.createElement('div');
      secretDiv.style.marginTop = '16px';
      secretDiv.style.fontSize = '12px';
      secretDiv.style.color = '#666';
      secretDiv.textContent = `Manual entry key: ${data.secret}`;
      container.appendChild(secretDiv);
    };
    document.head.appendChild(qrCodeScript);
  } catch (err) {
    document.getElementById('qr-container').textContent = 'Error loading QR code: ' + err.message;
  }
}

function renderTwoFactorSettings() {
  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page-shell">
      <section class="page-header">
        <div>
          <p class="eyebrow">SECURITY</p>
          <h2>Enable Google Authenticator 2FA</h2>
        </div>
        <button class="button secondary small" id="back-to-dashboard-btn">Back</button>
      </section>

      <section class="panel-card">
        <div class="panel-header">
          <div>
            <p class="eyebrow">TWO-FACTOR AUTH</p>
            <h3>Secure your admin login</h3>
          </div>
        </div>
        <p>Scan the QR code below with Google Authenticator or another TOTP app, then enter the 6-digit code to enable 2FA for this admin account.</p>
        <div id="admin-2fa-qr" style="text-align:center; margin: 20px 0; padding: 20px; background: #f5f5f5; border-radius: 8px; min-height: 280px;">Loading QR code...</div>
        <div class="input-group">
          <label for="admin-setup-code">Verification Code</label>
          <input id="admin-setup-code" type="text" inputmode="numeric" placeholder="000000" maxlength="6" />
        </div>
        <button class="button full" id="admin-enable-2fa-btn">Enable 2FA</button>
      </section>
    </div>
  `;

  document.getElementById('back-to-dashboard-btn').addEventListener('click', () => renderHome());

  document.getElementById('admin-enable-2fa-btn').addEventListener('click', async () => {
    const code = document.getElementById('admin-setup-code').value.trim();
    const secret = document.getElementById('admin-2fa-qr').getAttribute('data-secret');
    if (!code || code.length !== 6) return showAlert('Enter a valid 6-digit code');
    if (!currentAdminId) return showAlert('Please sign in again to enable 2FA');

    try {
      const response = await fetchWithAuth('/api/admin/2fa/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: currentAdminId, code, secret }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new Error(data.error || 'Failed to enable 2FA');
      createToast('2FA enabled successfully. Future logins will require Google Authenticator.', 'success');
      setTimeout(() => renderHome(), 1200);
    } catch (err) {
      showAlert(err.message || 'Failed to enable 2FA');
    }
  });

  loadAdminTwoFactorQRCode();
}

async function loadAdminTwoFactorQRCode() {
  const container = document.getElementById('admin-2fa-qr');
  if (!currentAdminId) {
    container.textContent = 'Admin session not available.';
    return;
  }

  try {
    const response = await fetchWithAuth('/api/admin/2fa/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: currentAdminId }),
    });
    const data = await readResponse(response);
    if (!response.ok) throw new Error(data.error || 'Failed to setup 2FA');

    container.setAttribute('data-secret', data.secret);
    const qrCodeScript = document.createElement('script');
    qrCodeScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    qrCodeScript.onload = () => {
      container.innerHTML = '';
      new QRCode(container, {
        text: data.otpauthUrl,
        width: 220,
        height: 220,
        colorDark: '#111827',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });
      const secretDiv = document.createElement('div');
      secretDiv.style.marginTop = '16px';
      secretDiv.style.fontSize = '12px';
      secretDiv.style.color = '#666';
      secretDiv.textContent = `Manual entry key: ${data.secret}`;
      container.appendChild(secretDiv);
    };
    document.head.appendChild(qrCodeScript);
  } catch (err) {
    container.textContent = 'Error loading QR code: ' + err.message;
  }
}

function updateNavActive() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-nav') === currentView);
  });
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!['home', 'pending'].includes(currentView)) return;
  autoRefreshTimer = setInterval(() => {
    if (currentView === 'home') renderHome();
    if (currentView === 'pending') renderPending();
  }, REFRESH_INTERVAL);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function renderApp() {
  currentView = 'home';
  setTheme(getInitialTheme());
  appContent.innerHTML = `
    <div class="admin-shell">
      <aside class="sidebar">
        <div class="brand-block">
          <div class="brand-mark">U</div>
          <div>
            <p class="eyebrow">FINTECH ADMIN</p>
            <h2>Upward</h2>
          </div>
        </div>

        <nav class="sidebar-nav">
          <button class="nav-item active" data-nav="home">Dashboard</button>
          <button class="nav-item" data-nav="pending">Pending Approvals</button>
          <button class="nav-item" data-nav="users">App Users</button>
          <button class="nav-item" data-nav="wallet">Add Wallet Balance</button>
          <button class="nav-item" data-nav="payment">Payment Details</button>
        </nav>
      </aside>

      <div class="main-panel">
        <header class="topbar">
          <div class="topbar-left">
            <button class="icon-button" id="sidebar-toggle">☰</button>
            <div>
              <p class="eyebrow">Finance Command Center</p>
              <h3>Admin dashboard</h3>
            </div>
          </div>
          <div class="topbar-right">
            <label class="search-box" for="main-search">
              <span>⌕</span>
              <input id="main-search" type="text" placeholder="Search users or requests" />
            </label>
            <button class="icon-button" id="theme-toggle">☀︎</button>
            <div class="profile-menu-container">
              <button class="profile-button" id="profile-btn">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="16" cy="16" r="15" stroke="currentColor" stroke-width="1.5"/>
                  <circle cx="16" cy="11" r="4" fill="currentColor"/>
                  <path d="M8 24c0-4.418 3.582-8 8-8s8 3.582 8 8" fill="currentColor" opacity="0.6"/>
                </svg>
              </button>
              <div class="profile-dropdown" id="profile-dropdown">
                <div class="dropdown-item" id="enable-2fa-menu-btn">🔐 Enable 2FA</div>
                <div class="dropdown-divider"></div>
                <div class="dropdown-item logout" id="logout-menu-btn">🚪 Logout</div>
              </div>
            </div>
          </div>
        </header>

        <div class="alerts"></div>
        <div class="toasts"></div>
        <section id="main-area"></section>
      </div>
    </div>
  `;

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    appContent.querySelector('.admin-shell').classList.toggle('sidebar-open');
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const nextTheme = document.body.classList.contains('light-theme') ? 'dark' : 'light';
    setTheme(nextTheme);
  });

  const profileBtn = document.getElementById('profile-btn');
  const profileDropdown = document.getElementById('profile-dropdown');

  if (profileBtn && profileDropdown) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      profileDropdown.classList.toggle('show');
    });

    const closeDropdown = (e) => {
      if (profileDropdown && !profileDropdown.contains(e.target) && e.target !== profileBtn) {
        profileDropdown.classList.remove('show');
      }
    };
    
    document.addEventListener('click', closeDropdown);

    profileDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.getElementById('logout-menu-btn').addEventListener('click', () => {
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminId');
      adminToken = '';
      currentAdminId = '';
      stopAutoRefresh();
      renderLogin();
    });

    document.getElementById('enable-2fa-menu-btn').addEventListener('click', () => {
      profileDropdown.classList.remove('show');
      renderTwoFactorSettings();
    });
  }

  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => renderMain(button.getAttribute('data-nav')));
  });

  document.getElementById('main-search').addEventListener('input', (event) => {
    const value = event.target.value.trim();
    if (currentView === 'users') {
      currentUsersSearch = value;
      renderUsers(value);
    } else if (currentView === 'pending') {
      renderPending(value);
    }
  });

  renderMain('home');
}

function renderMain(view) {
  stopAutoRefresh();
  currentView = view;
  clearAlert();
  updateNavActive();
  if (view === 'home') return renderHome();
  if (view === 'users') return renderUsers();
  if (view === 'wallet') return renderWallet();
  if (view === 'payment') return renderPayment();
  if (view === 'pending') return renderPending();
}

async function renderHome() {
  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page-shell">
      <section class="hero-card">
        <div>
          <p class="eyebrow">OVERVIEW</p>
          <h2>Control center for deposits, users, and approvals</h2>
          <p>Monitor account activity, approve finance requests, and keep the platform healthy with a clear operational view.</p>
        </div>
        <div class="hero-actions">
          <button class="button" data-nav="pending">Review pending requests</button>
          <button class="button secondary" data-nav="users">View users</button>
        </div>
      </section>

      <section class="stats-grid">
        <article class="stat-card">
          <p class="eyebrow">Users</p>
          <h3 id="stat-users">—</h3>
          <span>Total app users</span>
        </article>
        <article class="stat-card">
          <p class="eyebrow">Deposits</p>
          <h3 id="stat-deposits">—</h3>
          <span>Total deposits</span>
        </article>
        <article class="stat-card">
          <p class="eyebrow">Withdrawals</p>
          <h3 id="stat-withdrawals">—</h3>
          <span>Total withdrawals</span>
        </article>
        <article class="stat-card">
          <p class="eyebrow">Approvals</p>
          <h3 id="stat-pending">—</h3>
          <span>Pending approvals</span>
        </article>
        <article class="stat-card">
          <p class="eyebrow">Wallet balance</p>
          <h3 id="stat-balance">—</h3>
          <span>Total wallet balance</span>
        </article>
        <article class="stat-card">
          <p class="eyebrow">Portfolio</p>
          <h3 id="stat-portfolio">—</h3>
          <span>Portfolio value</span>
        </article>
        <article class="stat-card">
          <p class="eyebrow">Today deposits</p>
          <h3 id="stat-today-deposits">—</h3>
          <span>Completed today</span>
        </article>
        <article class="stat-card">
          <p class="eyebrow">Today withdrawals</p>
          <h3 id="stat-today-withdrawals">—</h3>
          <span>Completed today</span>
        </article>
      </section>

      <section class="content-grid">
        <div class="panel-card wide">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Recent activity</p>
              <h3>Latest requests needing review</h3>
            </div>
            <button class="button secondary small" data-nav="pending">Open approvals</button>
          </div>
          <div id="activity-list" class="stack"></div>
        </div>
        <div class="panel-card">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Quick actions</p>
              <h3>Go directly</h3>
            </div>
          </div>
          <div class="stack compact">
            <button class="action-tile" data-nav="users">Manage users</button>
            <button class="action-tile" data-nav="wallet">Add or deduct balance</button>
            <button class="action-tile" data-nav="payment">Update deposit settings</button>
          </div>
        </div>
      </section>
    </div>
  `;

  document.querySelectorAll('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => renderMain(button.getAttribute('data-nav')));
  });

  try {
    const summaryRes = await fetchWithAuth('/api/admin/summary');
    const summaryData = await readResponse(summaryRes);
    if (!summaryRes.ok) throw new Error(summaryData.error || 'Failed to load summary');

    const txRes = await fetchWithAuth('/api/admin/transactions');
    const txData = await readResponse(txRes);
    if (!txRes.ok) throw new Error(txData.error || 'Failed to load transactions');

    const transactions = Array.isArray(txData.transactions) ? txData.transactions : [];
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todaysDeposits = transactions.filter((tx) => tx.type === 'deposit' && tx.status === 'completed' && new Date(tx.createdAt) >= startOfToday);
    const todaysWithdrawals = transactions.filter((tx) => tx.type === 'withdraw' && tx.status === 'completed' && new Date(tx.createdAt) >= startOfToday);

    document.getElementById('stat-users').textContent = Number(summaryData.userCount || 0).toLocaleString('en-IN');
    document.getElementById('stat-deposits').textContent = formatCurrency(summaryData.totalDeposited || 0);
    document.getElementById('stat-withdrawals').textContent = formatCurrency(summaryData.totalWithdrawn || 0);
    document.getElementById('stat-pending').textContent = Number(summaryData.pendingCount || 0).toLocaleString('en-IN');
    document.getElementById('stat-balance').textContent = formatCurrency(summaryData.totalBalance || 0);
    // Use totalPortfolioValue from server (fallback to 0)
    document.getElementById('stat-portfolio').textContent = formatCurrency(summaryData.totalPortfolioValue || 0);
    document.getElementById('stat-today-deposits').textContent = formatCurrency(todaysDeposits.reduce((sum, tx) => sum + Number(tx.amount || 0), 0));
    document.getElementById('stat-today-withdrawals').textContent = formatCurrency(todaysWithdrawals.reduce((sum, tx) => sum + Number(tx.amount || 0), 0));

    const activityList = document.getElementById('activity-list');
    const recent = Array.isArray(summaryData.recentPending) ? summaryData.recentPending : [];
    if (!recent.length) {
      activityList.innerHTML = '<div class="empty-state">No pending requests at the moment.</div>';
    } else {
      activityList.innerHTML = recent.slice(0, 5).map((tx) => `
        <div class="activity-item">
          <div>
            <strong>${tx.user?.username || tx.userId || 'Guest'}</strong>
            <p>${tx.type} • ${formatCurrency(tx.amount)} • ${formatDate(tx.createdAt)}</p>
          </div>
          <span class="status-pill pending">${tx.status}</span>
        </div>
      `).join('');
    }

    startAutoRefresh();
  } catch (error) {
    showAlert(error.message || 'Unable to load dashboard');
  }
}

async function renderUsers(search = currentUsersSearch) {
  currentUsersSearch = search;
  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page-shell">
      <section class="page-header">
        <div>
          <p class="eyebrow">USER MANAGEMENT</p>
          <h2>Registered app users</h2>
        </div>
        <div class="toolbar">
          <label class="search-box compact" for="user-search">
            <span>⌕</span>
            <input id="user-search" type="text" value="${search}" placeholder="Search by name, email, or phone" />
          </label>
          <button class="button secondary small" id="refresh-users">Refresh</button>
          <button class="button secondary small" id="export-users">Export CSV</button>
        </div>
      </section>

      <section class="filter-row">
        <button class="filter-pill ${currentUsersFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>
        <button class="filter-pill ${currentUsersFilter === 'active' ? 'active' : ''}" data-filter="active">Active</button>
        <button class="filter-pill ${currentUsersFilter === 'suspended' ? 'active' : ''}" data-filter="suspended">Suspended</button>
      </section>

      <section class="panel-card">
        <div id="users-table"></div>
      </section>
    </div>
  `;

  document.getElementById('refresh-users').addEventListener('click', () => renderUsers(search));
  document.getElementById('user-search').addEventListener('input', (event) => renderUsers(event.target.value.trim()));
  document.querySelectorAll('.filter-pill').forEach((button) => {
    button.addEventListener('click', () => {
      currentUsersFilter = button.getAttribute('data-filter');
      renderUsers(currentUsersSearch);
    });
  });
  document.getElementById('export-users').addEventListener('click', () => exportTable(currentUsersData, 'users.csv'));

  await loadUsers(search);
}

async function loadUsers(search = '') {
  try {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await fetchWithAuth(`/api/admin/users${q}`);
    const data = await readResponse(res);
    if (!res.ok) throw new Error(data.error || data.message || `Failed to load users (${res.status})`);

    const users = Array.isArray(data.users) ? data.users : [];
    const filteredUsers = users.filter((user) => {
      if (currentUsersFilter === 'active') return true;
      if (currentUsersFilter === 'suspended') return false;
      return true;
    });

    currentUsersData = filteredUsers;
    currentUsersPage = 1;

    const tableContainer = document.getElementById('users-table');
    if (!filteredUsers.length) {
      tableContainer.innerHTML = '<div class="empty-state">No users found.</div>';
      return;
    }

    const pageUsers = filteredUsers.slice(0, PAGE_SIZE);
    tableContainer.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Profile</th>
              <th>User ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Joined</th>
              <th>Status</th>
              <th>Wallet</th>
              <th>Portfolio</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pageUsers.map((user) => `
              <tr>
                <td><div class="avatar">${(user.username || 'U').slice(0, 1).toUpperCase()}</div></td>
                <td>${user.id}</td>
                <td>${user.username || 'Unnamed user'}</td>
                <td>${user.email || '—'}</td>
                <td>${user.phoneNumber || '—'}</td>
                <td>${formatDate(user.createdAt)}</td>
                <td><span class="status-pill approved">Active</span></td>
                <td>${formatCurrency(user.balance || 0)}</td>
                <td>${formatCurrency(user.portfolioValue || 0)}</td>
                <td>
                  <div class="row-actions">
                    <button class="small-action" data-action="view" data-user-id="${user.id}" data-user-name="${encodeURIComponent(user.username || 'User')}">View</button>
                    <button class="small-action" data-action="edit" data-user-id="${user.id}">Edit</button>
                    <button class="small-action warn" data-action="suspend" data-user-id="${user.id}">Suspend</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.querySelectorAll('[data-action="view"]').forEach((button) => {
      button.addEventListener('click', () => {
        const userId = button.getAttribute('data-user-id');
        const userName = decodeURIComponent(button.getAttribute('data-user-name') || 'User');
        renderUserProfile({ id: userId, username: userName });
      });
    });

    document.querySelectorAll('[data-action="edit"]').forEach((button) => {
      button.addEventListener('click', () => createToast('Edit flow can be connected to the user management API next.', 'success'));
    });

    document.querySelectorAll('[data-action="suspend"]').forEach((button) => {
      button.addEventListener('click', () => createToast('Suspend action can be wired to a stricter user-management endpoint.', 'success'));
    });
  } catch (error) {
    showAlert(error.message || 'Could not load users');
  }
}

function renderUserProfile(user) {
  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page-shell">
      <section class="page-header">
        <div>
          <p class="eyebrow">USER PROFILE</p>
          <h2>${user.username || 'User profile'}</h2>
        </div>
        <button class="button secondary small" id="back-users">Back to users</button>
      </section>

      <section class="content-grid">
        <div class="panel-card">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Personal details</p>
              <h3>Identity and contact</h3>
            </div>
          </div>
          <div class="details-grid">
            <div><span class="detail-label">Full name</span><strong>${user.username || '—'}</strong></div>
            <div><span class="detail-label">Mobile number</span><strong>—</strong></div>
            <div><span class="detail-label">Email</span><strong>${user.email || '—'}</strong></div>
            <div><span class="detail-label">Registration date</span><strong>${formatDate(user.createdAt)}</strong></div>
          </div>
        </div>
        <div class="panel-card">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Financial details</p>
              <h3>Balances and activity</h3>
            </div>
          </div>
          <div class="details-grid">
            <div><span class="detail-label">Wallet balance</span><strong>${formatCurrency(user.balance || 0)}</strong></div>
            <div><span class="detail-label">Portfolio value</span><strong>${formatCurrency(user.portfolioValue || 0)}</strong></div>
            <div><span class="detail-label">Total deposits</span><strong>${formatCurrency(0)}</strong></div>
            <div><span class="detail-label">Total withdrawals</span><strong>${formatCurrency(0)}</strong></div>
          </div>
        </div>
      </section>

      <section class="panel-card">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Transaction history</p>
            <h3>Deposit and withdrawal activity</h3>
          </div>
        </div>
        <div id="user-history"></div>
      </section>
    </div>
  `;

  document.getElementById('back-users').addEventListener('click', () => renderUsers(currentUsersSearch));
  loadUserHistory(user.id);
}

async function loadUserHistory(userId) {
  try {
    const res = await fetchWithAuth('/api/admin/transactions');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    const rows = Array.isArray(data.transactions) ? data.transactions.filter((tx) => tx.userId === userId) : [];
    const target = document.getElementById('user-history');
    if (!rows.length) {
      target.innerHTML = '<div class="empty-state">No transaction history for this user yet.</div>';
      return;
    }

    target.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Method</th><th>Date</th></tr></thead>
          <tbody>
            ${rows.map((tx) => `
              <tr>
                <td>${tx.type}</td>
                <td>${formatCurrency(tx.amount || 0)}</td>
                <td><span class="status-pill ${tx.status === 'completed' ? 'approved' : 'pending'}">${tx.status}</span></td>
                <td>${tx.paymentMethod || '—'}</td>
                <td>${formatDate(tx.createdAt)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    showAlert(error.message || 'Unable to load transaction history');
  }
}

async function renderPending(search = '') {
  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page-shell">
      <section class="page-header">
        <div>
          <p class="eyebrow">PENDING APPROVALS</p>
          <h2>Review finance requests</h2>
        </div>
        <div class="toolbar">
          <label class="search-box compact" for="pending-search">
            <span>⌕</span>
            <input id="pending-search" type="text" value="${search}" placeholder="Search requests" />
          </label>
          <button class="button secondary small" id="refresh-pending">Refresh</button>
        </div>
      </section>

      <section class="filter-row">
        <button class="filter-pill ${currentPendingTab === 'deposit' ? 'active' : ''}" data-tab="deposit">Deposit approvals</button>
        <button class="filter-pill ${currentPendingTab === 'withdrawal' ? 'active' : ''}" data-tab="withdrawal">Withdrawal approvals</button>
      </section>

      <section class="panel-card">
        <div id="pending-table"></div>
      </section>
    </div>
  `;

  document.getElementById('refresh-pending').addEventListener('click', () => renderPending(search));
  document.getElementById('pending-search').addEventListener('input', (event) => renderPending(event.target.value.trim()));
  document.querySelectorAll('.filter-pill').forEach((button) => {
    button.addEventListener('click', () => {
      currentPendingTab = button.getAttribute('data-tab');
      renderPending(search);
    });
  });

  await loadPendingTransactions(search);
}

async function loadPendingTransactions(search = '') {
  try {
    const res = await fetchWithAuth('/api/admin/pending-transactions');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load pending requests');

    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    const filtered = transactions.filter((tx) => {
      const haystack = `${tx.user?.username || ''} ${tx.type || ''} ${tx.paymentMethod || ''} ${tx.utrNumber || ''}`.toLowerCase();
      return !search || haystack.includes(search.toLowerCase());
    });

    const subset = currentPendingTab === 'withdrawal'
      ? filtered.filter((tx) => tx.type === 'withdraw')
      : filtered.filter((tx) => tx.type === 'deposit');

    const table = document.getElementById('pending-table');
    if (!subset.length) {
      table.innerHTML = '<div class="empty-state">No requests match this view.</div>';
      return;
    }

    if (currentPendingTab === 'deposit') {
      table.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>User</th><th>Amount</th><th>Screenshot</th><th>Submitted</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              ${subset.map((tx) => `
                <tr>
                  <td>${tx.user?.username || tx.userId}</td>
                  <td>${formatCurrency(tx.amount || 0)}</td>
                  <td>${tx.proofUrl ? `<button class="small-action" data-action="download-proof" data-id="${tx.id}">Download proof</button>` : '—'}</td>
                  <td>${formatDate(tx.createdAt)}</td>
                  <td><span class="status-pill pending">${tx.status}</span></td>
                  <td>
                    <div class="row-actions">
                      <button class="small-action" data-action="approve" data-id="${tx.id}">Approve</button>
                      <button class="small-action warn" data-action="reject" data-id="${tx.id}">Reject</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else {
      table.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>User</th><th>Amount</th><th>Bank / UPI</th><th>Requested</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              ${subset.map((tx) => `
                <tr>
                  <td>${tx.user?.username || tx.userId}</td>
                  <td>${formatCurrency(tx.amount || 0)}</td>
                  <td>${tx.paymentMethod || '—'}</td>
                  <td>${formatDate(tx.createdAt)}</td>
                  <td><span class="status-pill pending">${tx.status}</span></td>
                  <td>
                    <div class="row-actions">
                      <button class="small-action" data-action="approve" data-id="${tx.id}">Approve</button>
                      <button class="small-action warn" data-action="reject" data-id="${tx.id}">Reject</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    document.querySelectorAll('[data-action="approve"]').forEach((button) => {
      button.addEventListener('click', () => handleVerify(button.getAttribute('data-id'), 'approve'));
    });
    document.querySelectorAll('[data-action="reject"]').forEach((button) => {
      button.addEventListener('click', () => handleVerify(button.getAttribute('data-id'), 'reject'));
    });
    document.querySelectorAll('[data-action="download-proof"]').forEach((button) => {
      button.addEventListener('click', () => downloadProof(button.getAttribute('data-id')));
    });
  } catch (error) {
    showAlert(error.message || 'Could not load pending requests');
  }
}

async function renderWallet(userId = null, username = '') {
  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page-shell">
      <section class="page-header">
        <div>
          <p class="eyebrow">WALLET MANAGEMENT</p>
          <h2>Add or deduct wallet balance</h2>
        </div>
      </section>

      <section class="content-grid">
        <div class="panel-card">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Select user</p>
              <h3>Find the account</h3>
            </div>
          </div>
          <label class="search-box compact" for="wallet-search">
            <span>⌕</span>
            <input id="wallet-search" type="text" placeholder="Search user" />
          </label>
          <div id="wallet-user-list" class="stack"></div>
        </div>
        <div class="panel-card">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Adjustment form</p>
              <h3>Adjust account balance safely</h3>
            </div>
          </div>
          <div id="wallet-form"></div>
        </div>
      </section>
    </div>
  `;

  document.getElementById('wallet-search').addEventListener('input', (event) => fetchWalletUsers(event.target.value.trim()));
  if (userId) {
    await fetchWalletUsers('', { id: userId, username });
  } else {
    await fetchWalletUsers();
  }
}

async function fetchWalletUsers(filter = '', selectedUser = null) {
  try {
    const q = filter ? `?search=${encodeURIComponent(filter)}` : '';
    const res = await fetchWithAuth('/api/admin/users' + q);
    const data = await readResponse(res);
    if (!res.ok) throw new Error(data.error || data.message || `Failed (${res.status})`);

    const list = document.getElementById('wallet-user-list');
    const users = Array.isArray(data.users) ? data.users : [];
    if (!users.length) {
      list.innerHTML = '<div class="empty-state">No users found.</div>';
      return;
    }

    list.innerHTML = users.map((user) => `
      <button class="activity-item action-item" data-wallet-user-id="${user.id}" data-wallet-username="${encodeURIComponent(user.username || 'User')}">
        <div>
          <strong>${user.username || 'User'}</strong>
          <p>${user.email || '—'} • ${formatCurrency(user.balance || 0)}</p>
        </div>
        <span class="status-pill approved">Select</span>
      </button>
    `).join('');

    document.querySelectorAll('[data-wallet-user-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-wallet-user-id');
        const username = decodeURIComponent(button.getAttribute('data-wallet-username') || 'User');
        showWalletForm({ id, username });
      });
    });

    if (selectedUser) {
      showWalletForm(selectedUser);
    }
  } catch (error) {
    showAlert(error.message || 'Failed to load users');
  }
}

function showWalletForm(user) {
  const container = document.getElementById('wallet-form');
  container.innerHTML = `
    <div class="input-group">
      <label>User</label>
      <input value="${user.username || ''}" readonly />
    </div>
    <div class="input-group">
      <label>User ID</label>
      <input value="${user.id || ''}" readonly />
    </div>
    <div class="input-group">
      <label>Amount</label>
      <input id="wallet-amount" type="number" min="1" value="1000" />
    </div>
    <div class="input-group">
      <label>Transaction type</label>
      <select id="wallet-type">
        <option value="add">Add balance</option>
        <option value="deduct">Deduct balance</option>
      </select>
    </div>
    <div class="input-group">
      <label>Reason</label>
      <input id="wallet-reason" value="Admin adjustment" />
    </div>
    <div class="input-group">
      <label>Remarks</label>
      <textarea id="wallet-remarks">Reviewed and approved by admin.</textarea>
    </div>
    <div class="toolbar">
      <button class="button" id="wallet-submit">Submit adjustment</button>
    </div>
  `;

  document.getElementById('wallet-submit').addEventListener('click', async () => {
    const amount = Number(document.getElementById('wallet-amount').value || 0);
    const txType = document.getElementById('wallet-type').value;
    const reason = document.getElementById('wallet-reason').value || 'Admin adjustment';
    const remarks = document.getElementById('wallet-remarks').value || '';

    if (!amount || amount <= 0) return showAlert('Enter a valid amount');

    const confirmed = window.confirm(`${txType === 'deduct' ? 'Deduct' : 'Add'} ₹${amount} to ${user.username || 'this user'}?`);
    if (!confirmed) return;

    try {
      const adjustedAmount = txType === 'deduct' ? -Math.abs(amount) : Math.abs(amount);
      const res = await fetchWithAuth('/api/admin/add-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, website: 'default', amount: adjustedAmount, reason: `${reason} — ${remarks}` }),
      });
      const data = await readResponse(res);
      if (!res.ok) {
        throw new Error(data.error || data.message || `Adjustment failed (${data.status || res.status})`);
      }
      createToast(data.message || 'Wallet adjustment completed.', 'success');
      // Optionally show updated balance in an alert briefly
      if (typeof data.balance !== 'undefined') {
        showAlert(`New balance: ${formatCurrency(data.balance)}`, 'ok');
      }
      renderWallet(user.id, user.username);
    } catch (error) {
      showAlert(error.message || 'Wallet adjustment failed');
    }
  });
}

async function renderPayment() {
  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page-shell">
      <section class="page-header">
        <div>
          <p class="eyebrow">PAYMENT DETAILS</p>
          <h2>Manage deposit payment settings</h2>
        </div>
      </section>
      <section class="panel-card">
        <div id="settings-form"></div>
      </section>
    </div>
  `;

  try {
    const res = await fetchWithAuth('/api/admin/deposit-settings');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    const settings = data.settings || {};
    const form = document.getElementById('settings-form');
    form.innerHTML = `
      <form id="deposit-settings-form">
        <div class="content-grid">
          <div class="panel-card compact">
            <div class="panel-header">
              <div>
                <p class="eyebrow">Bank account</p>
                <h3>Bank details</h3>
              </div>
            </div>
            <div class="input-group"><label>Account holder name</label><input id="s-holder" value="${settings.bankAccountHolder || ''}" /></div>
            <div class="input-group"><label>Bank name</label><input id="s-bank" value="${settings.bankName || ''}" /></div>
            <div class="input-group"><label>Account number</label><input id="s-account" value="${settings.bankAccountNumber || ''}" /></div>
            <div class="input-group"><label>IFSC code</label><input id="s-ifsc" value="${settings.bankIfsc || ''}" /></div>
            <div class="input-group"><label>Branch name</label><input id="s-branch" value="${settings.bankBranch || ''}" /></div>
          </div>
          <div class="panel-card compact">
            <div class="panel-header">
              <div>
                <p class="eyebrow">UPI and QR</p>
                <h3>Instant payment setup</h3>
              </div>
            </div>
            <div class="input-group"><label>UPI ID</label><input id="s-upi" value="${settings.upiId || ''}" /></div>
            <div class="input-group"><label>Deposit instructions</label><textarea id="s-instructions">${settings.instructions || ''}</textarea></div>
            <div class="input-group">
              <label>QR Code</label>
              <div class="file-preview">
                ${settings.qrCodePath ? `<img id="qr-preview" src="${settings.qrCodePath}" alt="qr" />` : '<div class="empty-state">No QR uploaded</div>'}
                <input id="s-qr" type="file" accept="image/*" />
              </div>
            </div>
          </div>
        </div>
        <div class="toolbar top-space">
          <button class="button" type="submit">Save the updates</button>
        </div>
      </form>
    `;

    document.getElementById('s-qr').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const preview = document.getElementById('qr-preview');
        if (preview) preview.src = reader.result;
        else {
          const previewBox = document.querySelector('.file-preview');
          const emptyState = previewBox.querySelector('.empty-state');
          const image = document.createElement('img');
          image.id = 'qr-preview';
          image.alt = 'qr';
          image.src = reader.result;
          if (emptyState) emptyState.replaceWith(image);
          else previewBox.prepend(image);
        }
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('deposit-settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const formData = new FormData();
        formData.append('upiId', document.getElementById('s-upi').value || '');
        formData.append('bankAccountHolder', document.getElementById('s-holder').value || '');
        formData.append('bankAccountNumber', document.getElementById('s-account').value || '');
        formData.append('bankName', document.getElementById('s-bank').value || '');
        formData.append('bankBranch', document.getElementById('s-branch').value || '');
        formData.append('bankIfsc', document.getElementById('s-ifsc').value || '');
        formData.append('instructions', document.getElementById('s-instructions').value || '');
        const fileInput = document.getElementById('s-qr');
        if (fileInput && fileInput.files && fileInput.files[0]) {
          formData.append('qrFile', fileInput.files[0]);
        }
        const response = await fetchWithAuth('/api/admin/deposit-settings', { method: 'POST', body: formData });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Failed to save settings');
        createToast('Payment settings updated successfully.', 'success');
      } catch (error) {
        showAlert(error.message || 'Save failed');
      }
    });
  } catch (error) {
    showAlert(error.message || 'Failed to load payment settings');
  }
}

async function handleVerify(id, action) {
  const confirmed = window.confirm(`Are you sure you want to ${action} this request?`);
  if (!confirmed) return;

  try {
    const response = await fetchWithAuth('/api/admin/verify-transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: id, action, notes: `${action} by admin` }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed');
    createToast(data.message || 'Request updated.', 'success');
    renderPending(currentUsersSearch);
  } catch (error) {
    showAlert(error.message || 'Verification failed');
  }
}

async function downloadProof(transactionId) {
  if (!transactionId) return;

  try {
    const response = await fetchWithAuth(`/api/admin/download-proof?transactionId=${encodeURIComponent(transactionId)}`);
    if (!response.ok) {
      const data = await readResponse(response);
      throw new Error(data.error || 'Failed to download proof');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `payment-proof-${transactionId}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showAlert(error.message || 'Failed to download proof');
  }
}

function exportTable(rows, filename) {
  const headers = ['id', 'username', 'email', 'balance'];
  const csvRows = [headers.join(',')];
  rows.forEach((row) => {
    const cleaned = [row.id || '', row.username || '', row.email || '', row.balance || ''];
    csvRows.push(cleaned.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function verifyAdmin() {
  try {
    const response = await fetchWithAuth('/api/admin/verify-session');
    if (!response.ok) throw new Error('Not authorized');
    renderApp();
  } catch (err) {
    localStorage.removeItem('adminToken');
    adminToken = '';
    renderLogin();
  }
}

verifyAdmin();
