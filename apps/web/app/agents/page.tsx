import type { Metadata } from 'next';
import { AgentActivity } from '@/components/agent-activity';
import { loadAgentActivity } from '@/lib/agent-activity-data';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Agent activity' };
export default async function AgentsPage() {
  const result = await loadAgentActivity();
  return <AgentActivity initial={result.ok ? result.data : undefined} />;
}
