import { loadAgentActivity } from '@/lib/agent-activity-data';
import { respond } from '@/lib/respond';
export const dynamic = 'force-dynamic';
export async function GET() { return respond(await loadAgentActivity()); }
