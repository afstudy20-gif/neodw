import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/shell.css';

window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  const root = document.getElementById('root');
  if (root && !root.hasChildNodes()) {
    root.innerHTML = `<div style="color:#f85149;padding:24px;font-family:monospace">
      <h2>NeoDW failed to start</h2>
      <pre>${event.error?.message || event.message}</pre>
      <pre>${event.error?.stack || ''}</pre>
    </div>`;
  }
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection:', event.reason);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
