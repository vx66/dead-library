document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('[type=submit]');
  const error = document.getElementById('loginError');
  button.disabled = true;
  error.style.display = 'none';
  try {
    const tokenResponse = await fetch('/admin/csrf', { cache: 'no-store' });
    if (!tokenResponse.ok) throw new Error('No se pudo iniciar la sesión de seguridad');
    const { csrfToken } = await tokenResponse.json();
    const response = await fetch('/admin/login', {
      method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
      body: new URLSearchParams(new FormData(form))
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'No se pudo iniciar sesión');
    }
    location.assign('/admin');
  } catch (failure) {
    error.textContent = failure.message;
    error.style.display = 'block';
    form.elements.password.value = '';
  } finally { button.disabled = false; }
});
