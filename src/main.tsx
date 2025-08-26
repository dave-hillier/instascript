import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ServiceProvider } from './contexts/ServiceProvider.tsx'
import { AppProvider } from './contexts/AppProvider.tsx'
import { ConversationProvider } from './contexts/ConversationProvider.tsx'
import { JobQueueProvider } from './contexts/JobQueueProvider.tsx'
import { RegenerationProvider } from './contexts/RegenerationProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServiceProvider>
      <AppProvider>
        <JobQueueProvider>
          <RegenerationProvider>
            <ConversationProvider>
              <App />
            </ConversationProvider>
          </RegenerationProvider>
        </JobQueueProvider>
      </AppProvider>
    </ServiceProvider>
  </StrictMode>,
)
