export function notifyDashboardBurstRefresh() {
  window.dispatchEvent(new CustomEvent('dashboard-burst-refresh'));
}
