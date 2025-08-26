import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppProvider } from './contexts/AppProvider.tsx'
import { ConversationProvider } from './contexts/ConversationProvider.tsx'
import { JobQueueProvider } from './contexts/JobQueueProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <JobQueueProvider>
        <ConversationProvider>
          <App />
        </ConversationProvider>
      </JobQueueProvider>
    </AppProvider>
  </StrictMode>,
)
