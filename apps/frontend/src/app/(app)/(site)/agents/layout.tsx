import { Metadata } from 'next';
import { Agent } from '@gitroom/frontend/components/agents/agent';
export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true' ? 'REKTRS Social - Agent' : 'Postiz - Agent',
  description: 'agents',
};
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Agent>{children}</Agent>;
}
