import { create } from 'zustand'

let notifId = 0

interface NotificationInput {
  type?: string
  message?: string
  title?: string
  persistent?: boolean
  [key: string]: unknown
}

interface Notification extends NotificationInput {
  id: number
  createdAt: number
}

interface User {
  id: string
  username: string
  [key: string]: unknown
}

interface Business {
  id: string
  name: string
  [key: string]: unknown
}

interface StoreState {
  // Auth
  user: User | null
  setUser: (user: User | null) => void

  // Business
  businesses: Business[]
  currentBusiness: Business | null
  setBusinesses: (businesses: Business[]) => void
  setCurrentBusiness: (business: Business | null) => void

  // Dashboard
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dashboard: Record<string, any> | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setDashboard: (data: Record<string, any> | null) => void

  // UI
  sidebarCollapsed: boolean
  toggleSidebar: () => void

  // Notifications (in-app toast)
  notifications: Notification[]
  addNotification: (n: NotificationInput) => number
  clearNotification: (id: number) => void
  clearAllNotifications: () => void

  // Signal counts (for sidebar badges)
  openSignalCount: number
  setOpenSignalCount: (count: number) => void

  pendingTaskCount: number
  setPendingTaskCount: (count: number) => void
}

const useStore = create<StoreState>((set, get) => ({
  // ============================================
  // Auth
  // ============================================
  user: null,
  setUser: (user) => set({ user }),

  // ============================================
  // Business
  // ============================================
  businesses: [],
  currentBusiness: null,
  setBusinesses: (businesses) => set({ businesses }),
  setCurrentBusiness: (business) => set({ currentBusiness: business }),

  // ============================================
  // Dashboard
  // ============================================
  dashboard: null,
  setDashboard: (data) => set({ dashboard: data }),

  // ============================================
  // UI
  // ============================================
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  // ============================================
  // Notifications (in-app toast)
  // ============================================
  notifications: [],
  addNotification: (n) => {
    const id = ++notifId
    const notification: Notification = { id, ...n, createdAt: Date.now() }
    set((state) => ({ notifications: [...state.notifications, notification] }))

    // Auto-dismiss after 5s unless persistent
    if (!n.persistent) {
      setTimeout(() => {
        get().clearNotification(id)
      }, 5000)
    }

    return id
  },
  clearNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),
  clearAllNotifications: () => set({ notifications: [] }),

  // ============================================
  // Signal counts (for sidebar badges)
  // ============================================
  openSignalCount: 0,
  setOpenSignalCount: (count) => set({ openSignalCount: count }),

  pendingTaskCount: 0,
  setPendingTaskCount: (count) => set({ pendingTaskCount: count }),
}))

export default useStore
