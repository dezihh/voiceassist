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

function stripSsml(text: string): string {
  return text
    .replace(/<speak>|<\/speak>/gi, '')
    .replace(/<break[^>]*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toSsml(resp: AssistantResponse): string {
  if (resp.ssml) {
    const s = resp.speech.trim();
    return /^<speak[\s>]/i.test(s) ? s : `<speak>${s}</speak>`;
  }
  return `<speak>${escapeXml(resp.speech)}</speak>`;
}

export function fromAssistantResponse(resp: AssistantResponse): Record<string, unknown> {
  const ssml = toSsml(resp);
  const outputSpeech = { type: 'SSML', ssml };
  const cardText = resp.ssml ? stripSsml(resp.speech) : resp.speech;
  return {
    version: '1.0',
    sessionAttributes: {},
    response: {
      outputSpeech,
      card: { type: 'Simple', title: 'VoiceAssist', content: cardText },
      reprompt: resp.followUp
        ? {
            outputSpeech: {
              type: 'SSML',
              ssml: toSsml({ speech: resp.followupPrompt ?? resp.speech }),
            },
          }
        : undefined,
      shouldEndSession: !resp.followUp,
    },
  };
}
