import { Metadata } from 'next';
import { Agent } from '@gitroom/frontend/components/agents/agent';
import { AgentChat } from '@gitroom/frontend/components/agents/agent.chat';
export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true' ? 'REKTRS Social - Agent' : 'Postiz - Agent',
  description: '',
};
export default async function Page() {
  return (
    <AgentChat />
  );
}
