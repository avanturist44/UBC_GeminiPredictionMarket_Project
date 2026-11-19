import { PublicationError, screenThesis, submitThesis, ThesisSubmissionSchema } from '@thesis/services';
import { json, publicationDb, publicationFailure, requestJson, viewerId } from '@/lib/publication-http';
export async function POST(request: Request) {
  try {
    const input = ThesisSubmissionSchema.parse(await requestJson(request));
    const id = await viewerId();
    if (!id) throw new PublicationError('session_required', 401);
    if (process.env.TRADING_ENABLED === 'false') throw new PublicationError('trading_disabled', 503);
    if (!screenThesis(input.headline, input.body) && (process.env.THESIS_AUDIT_ENABLED !== 'true' ||
      process.env.LLM_PROVIDER !== 'xai' || !process.env.XAI_API_KEY)) throw new PublicationError('auditing_disabled', 503);
    return json(await submitThesis(publicationDb(), id, input), 202);
  } catch (error) { return publicationFailure(error); }
}
