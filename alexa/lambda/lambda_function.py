import json
import logging
import os
import random
import re
import threading
import time

import requests
import ask_sdk_core.utils as ask_utils
from ask_sdk_core.skill_builder import CustomSkillBuilder
from ask_sdk_core.api_client import DefaultApiClient
from ask_sdk_core.dispatch_components import AbstractRequestHandler, AbstractExceptionHandler
from ask_sdk_model.services.directive import SendDirectiveRequest, Header, SpeakDirective
from ask_sdk_model.ui import SimpleCard
from ask_sdk_model.interfaces.alexa.presentation.apl import RenderDocumentDirective
from xml.sax.saxutils import escape

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG if os.environ.get("debug") else logging.INFO)


def load_config():
    """Optionale config.json aus dem Lambda-Verzeichnis (nur im Alexa-Repo,
    wird von der CI erhalten). Env-Variablen haben Vorrang."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    try:
        with open(path) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return
    for key, value in cfg.items():
        os.environ.setdefault(key, str(value))


load_config()

gateway_url = os.environ.get("gateway_url", "").rstrip("/")
gateway_token = os.environ.get("gateway_token", "")
acknowledgment_enabled = os.environ.get("acknowledgment_enabled", "false").lower() == "true"
ask_for_further_commands = os.environ.get("ask_for_further_commands", "false").lower() == "true"
warteton_enabled = os.environ.get("warteton_enabled", "true").lower() == "true"
warteton_phrase = os.environ.get("warteton_phrase", "Einen Moment, ich schaue das kurz nach.")
watchdog_delay = float(os.environ.get("watchdog_delay", "6.5"))
gateway_timeout = float(os.environ.get("gateway_timeout", "28"))
ALEXA_WINDOW = 8.0

SPEAK_WELCOME = "Hallo, ich bin Ihr Voice-Assistent. Was kann ich für Sie tun?"
SPEAK_HELP = "Sie können mir zum Beispiel nach dem Hausstatus oder aktuellen Informationen fragen."
SPEAK_STOP = random.choice(["Bis zum nächsten Mal.", "Alles klar, bis später.", "Okay, tschüss."])
SPEAK_ERROR = "Entschuldigung, da ist etwas schiefgelaufen."
SPEAK_PROCESSING = "Einen Moment bitte."


def strip_ssml(text):
    text = re.sub(r"<speak>|</speak>", "", text, flags=re.I)
    text = re.sub(r"<break[^>]*/?>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


CARD_TITLE = "MeinHelfer"

# APL-Layout: kontrollierte Schriftgroesse (28dp) + Scroll fuer lange Texte
APL_DOCUMENT = {
    "type": "APL",
    "version": "2023.1",
    "theme": "dark",
    "mainTemplate": {
        "parameters": ["payload"],
        "items": [{
            "type": "Container",
            "width": "100%",
            "height": "100%",
            "padding": "48dp",
            "items": [
                {
                    "type": "Text",
                    "text": "${payload.title}",
                    "fontSize": "26dp",
                    "fontWeight": "bold",
                    "color": "#00CAFF",
                    "shrink": 0,
                    "paddingBottom": "28dp",
                },
                {
                    "type": "ScrollView",
                    "width": "100%",
                    "grow": 1,
                    "items": [{
                        "type": "Text",
                        "text": "${payload.text}",
                        "fontSize": "28dp",
                        "lineHeight": 1.4,
                        "color": "#EEEEEE",
                    }],
                },
            ],
        }],
    },
}


def supports_apl(handler_input):
    try:
        device = handler_input.request_envelope.context.system.device
        interfaces = device.supported_interfaces if device else None
        return bool(interfaces and interfaces.alexa_presentation_apl)
    except AttributeError:
        return False


def render_apl(handler_input, title, text):
    handler_input.response_builder.add_directive(
        RenderDocumentDirective(
            token="mainhelfer-display-{}".format(int(time.time() * 1000)),
            document=APL_DOCUMENT,
            datasources={"payload": {"title": title, "text": text}},
        )
    )


def call_gateway(query, session_id, user_id):
    if not gateway_url:
        raise RuntimeError("gateway_url nicht konfiguriert")
    headers = {
        "Authorization": "Bearer {}".format(gateway_token),
        "Content-Type": "application/json",
    }
    data = {"sessionId": session_id, "text": query}
    if user_id:
        data["userId"] = user_id
    response = requests.post(
        "{}/api/query".format(gateway_url), headers=headers, json=data, timeout=gateway_timeout
    )
    response.raise_for_status()
    payload = response.json()
    # /api/query liefert EngineResult (route/response/trace) oder nacktes AssistantResponse
    resp = payload.get("response") if isinstance(payload.get("response"), dict) else payload
    speech = resp.get("speech") or SPEAK_ERROR
    follow_up = bool(resp.get("followUp"))
    followup_prompt = (resp.get("followupPrompt") or "").strip() or None
    ssml = bool(resp.get("ssml")) or speech.strip().startswith("<speak")
    display = resp.get("display") or {}
    display_text = (display.get("text") or "").strip() or None
    return speech, follow_up, ssml, display_text, followup_prompt


def send_progressive(handler_input, request, phrase):
    if not request.request_id:
        return
    try:
        directive_request = SendDirectiveRequest(
            header=Header(request_id=request.request_id),
            directive=SpeakDirective(speech=phrase),
        )
        directive_service = handler_input.service_client_factory.get_directive_service()
        directive_service.enqueue(directive_request)
    except Exception as e:
        logger.warning("Progressive Response fehlgeschlagen: %s", e)


def lambda_trace(session_id, event, elapsed_ms=None):
    """Fire-and-forget: Lambda-Lebenszyklus ins Gateway-Log (CloudWatch-Ersatz)."""
    if not gateway_url:
        return

    def run():
        try:
            requests.post(
                "{}/api/lambda-trace".format(gateway_url),
                headers={
                    "Authorization": "Bearer {}".format(gateway_token),
                    "Content-Type": "application/json",
                },
                json={"sessionId": session_id, "event": event, "elapsedMs": elapsed_ms},
                timeout=2,
            )
        except Exception as e:
            logger.warning("lambda-trace fehlgeschlagen: %s", e)

    threading.Thread(target=run, daemon=True).start()


class LaunchRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("LaunchRequest")(handler_input)

    def handle(self, handler_input):
        return (
            handler_input.response_builder
            .speak(SPEAK_WELCOME)
            .set_card(SimpleCard(title=CARD_TITLE, content=SPEAK_WELCOME))
            .ask(SPEAK_WELCOME)
            .response
        )


class GptQueryIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("GptQueryIntent")(handler_input)

    def handle(self, handler_input):
        request = handler_input.request_envelope.request
        session = handler_input.request_envelope.session
        response_builder = handler_input.response_builder

        query = request.intent.slots["query"].value
        session_id = session.session_id if session else "unknown"
        user_id = None
        if session and session.user:
            user_id = session.user.user_id

        logger.info("Query empfangen: %s", query)
        trace_start = time.monotonic()
        lambda_trace(session_id, "invoke", 0)

        if acknowledgment_enabled:
            send_progressive(handler_input, request, SPEAK_PROCESSING)

        result = {}

        def run():
            try:
                result["value"] = call_gateway(query, session_id, user_id)
            except Exception as e:
                result["error"] = e

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(watchdog_delay)
        if worker.is_alive():
            if warteton_enabled:
                logger.info("Watchdog nach %.1fs ohne Gateway-Antwort, sende Warteton", watchdog_delay)
                send_progressive(handler_input, request, warteton_phrase)
                worker.join(max(0.0, gateway_timeout - watchdog_delay))
            else:
                worker.join(max(0.0, ALEXA_WINDOW - watchdog_delay))
        if worker.is_alive():
            logger.error("Gateway-Antwort %.1fs ueberschritten", gateway_timeout)
            return response_builder.speak(SPEAK_ERROR).set_should_end_session(True).response
        if "error" in result:
            logger.error("Gateway-Fehler: %s", result["error"], exc_info=True)
            return response_builder.speak(SPEAK_ERROR).set_should_end_session(True).response

        speech, follow_up, is_ssml, display_text, followup_prompt = result["value"]

        logger.info(
            "Gateway-Antwort: %d Zeichen, ssml=%s, followUp=%s, ANFANG=%r, ENDE=%r",
            len(speech), is_ssml, follow_up, speech[:40], speech[-40:],
        )

        keep_open = follow_up or ask_for_further_commands
        lambda_trace(session_id, "response_sent", int((time.monotonic() - trace_start) * 1000))
        # ask-sdk speak() wrappt in <speak> und trimmt vorhandenen Wrapper;
        # Klartext muss XML-escaped werden (SSML aus dem Gateway nicht)
        response_builder.speak(escape(speech) if not is_ssml else speech)
        # Anzeige: Klartext ohne SSML-Tags (Echo Show / Alexa App)
        display = display_text or strip_ssml(speech)
        response_builder.set_card(SimpleCard(title=CARD_TITLE, content=display))
        # APL: kontrollierte Schriftgroesse + Scroll auf unterstuetzten Geraeten
        if supports_apl(handler_input):
            render_apl(handler_input, CARD_TITLE, display)
        if keep_open:
            # Dynamische Rueckfrage vom Gateway (situativ), sonst statischer Hinweis
            return response_builder.ask(followup_prompt or SPEAK_HELP).response
        return response_builder.set_should_end_session(True).response


class HelpIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.HelpIntent")(handler_input)

    def handle(self, handler_input):
        return (
            handler_input.response_builder
            .speak(SPEAK_HELP)
            .set_card(SimpleCard(title=CARD_TITLE, content=SPEAK_HELP))
            .ask(SPEAK_HELP)
            .response
        )


class CancelOrStopIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.CancelIntent")(handler_input) or ask_utils.is_intent_name(
            "AMAZON.StopIntent"
        )(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.speak(SPEAK_STOP).set_should_end_session(True).response


class FallbackIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.FallbackIntent")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.speak(SPEAK_HELP).ask(SPEAK_HELP).response


class SessionEndedRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("SessionEndedRequest")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.response


class CanFulfillIntentRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("CanFulfillIntentRequest")(handler_input)

    def handle(self, handler_input):
        intent = handler_input.request_envelope.request.intent
        intent_name = intent.name if intent else None
        if intent_name == "GptQueryIntent":
            return handler_input.response_builder.can_fulfill("YES").add_can_fulfill_intent("YES").response
        return handler_input.response_builder.can_fulfill("NO").add_can_fulfill_intent("NO").response


class CatchAllExceptionHandler(AbstractExceptionHandler):
    def can_handle(self, handler_input, exception):
        return True

    def handle(self, handler_input, exception):
        logger.error(exception, exc_info=True)
        return handler_input.response_builder.speak(SPEAK_ERROR).ask(SPEAK_ERROR).response


sb = CustomSkillBuilder(api_client=DefaultApiClient())
sb.add_request_handler(LaunchRequestHandler())
sb.add_request_handler(GptQueryIntentHandler())
sb.add_request_handler(HelpIntentHandler())
sb.add_request_handler(CancelOrStopIntentHandler())
sb.add_request_handler(FallbackIntentHandler())
sb.add_request_handler(SessionEndedRequestHandler())
sb.add_request_handler(CanFulfillIntentRequestHandler())
sb.add_exception_handler(CatchAllExceptionHandler())
lambda_handler = sb.lambda_handler()
