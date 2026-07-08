import '@testing-library/jest-dom/vitest'

// React Flow needs ResizeObserver which jsdom doesn't provide
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
