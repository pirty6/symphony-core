import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import Studio from './Studio'
import './studio.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReactFlowProvider>
      <Studio />
    </ReactFlowProvider>
  </StrictMode>,
)
