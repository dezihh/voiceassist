import type { AssistantResponse, VoiceQuery } from '../types.js';

interface AlexaRequestBody {
  session?: {
    sessionId?: string;
    user?: { userId?: string };
  };
  request?: {
    type?: string;
    intent?: {
      name?: string;
      slots?: Record<string, { value?: string }>;
    };
    rawUtterance?: string;
  };
}

export function toVoiceQuery(body: AlexaRequestBody): VoiceQuery {
  const intent = body.request?.intent;
  const slot = intent?.slots?.query ?? intent?.slots?.Query;
  const text = slot?.value ?? body.request?.rawUtterance ?? '';
  return {
    sessionId: body.session?.sessionId ?? 'alexa-unknown',
    userId: body.session?.user?.userId,
    text,
  };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fromAssistantResponse(resp: AssistantResponse): Record<string, unknown> {
  const outputSpeech = { type: 'SSML', ssml: `<speak>${escapeXml(resp.speech)}</speak>` };
  return {
    version: '1.0',
    sessionAttributes: {},
    response: {
      outputSpeech,
      card: { type: 'Simple', title: 'VoiceAssist', content: resp.speech },
      reprompt: resp.followUp ? { outputSpeech } : undefined,
      shouldEndSession: !resp.followUp,
    },
  };
}
