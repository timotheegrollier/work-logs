// Appliquer le thème avant React, sans script inline (CSP desktop).
document.documentElement.dataset.theme =
  localStorage.getItem('worklogs-theme') === 'light' ? 'light' : 'dark';
