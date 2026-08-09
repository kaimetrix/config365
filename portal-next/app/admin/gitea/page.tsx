import { redirectTo } from '@/lib/server/redirect';

export default async function GiteaPage() {
  redirectTo('/admin/platform');
}
