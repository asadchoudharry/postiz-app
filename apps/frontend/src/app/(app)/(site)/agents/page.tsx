import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true' ? 'REKTRS Social - Agent' : 'Postiz - Agent',
  description: '',
};

export default async function Page() {
  return redirect('/agents/new');
}
