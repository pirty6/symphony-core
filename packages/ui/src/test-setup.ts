import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

// Integration tests drive a real engine run; allow for slow CI machines.
configure({ asyncUtilTimeout: 4000 })

// React Flow needs ResizeObserver which jsdom doesn't provide
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
