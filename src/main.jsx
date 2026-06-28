import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Surface otherwise-silent failures: an IPC rejection that no caller catches would
// previously just make an action appear to do nothing. Log it so it's diagnosable.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] unhandled promise rejection:', event.reason)
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
