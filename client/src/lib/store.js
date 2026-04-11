import { create } from 'zustand'

let notifId = 0

const useStore = create((set, get) => ({
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
    const notification = { id, ...n, createdAt: Date.now() }
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
