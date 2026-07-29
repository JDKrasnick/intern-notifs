const form = document.querySelector('#profile-form');
const status = document.querySelector('#status');
const fields = ['firstName', 'lastName', 'email', 'phone', 'advance'];

chrome.storage.local.get('internnotifsQuickFill', ({ internnotifsQuickFill = {} }) => {
  for (const field of fields) {
    const element = document.querySelector(`#${field}`);
    if (!element) continue;
    if (element.type === 'checkbox') element.checked = internnotifsQuickFill[field] !== false;
    else element.value = internnotifsQuickFill[field] ?? '';
  }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const profile = Object.fromEntries(fields.map((field) => {
    const element = document.querySelector(`#${field}`);
    return [field, element.type === 'checkbox' ? element.checked : element.value.trim()];
  }));
  chrome.storage.local.set({ internnotifsQuickFill: profile }, () => {
    status.textContent = 'Saved in this browser.';
  });
});
