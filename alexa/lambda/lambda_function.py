import json
import logging
import os
import random
import threading

import requests
import ask_sdk_core.utils as ask_utils
from ask_sdk_core.skill_builder import CustomSkillBuilder
from ask_sdk_core.api_client import DefaultApiClient
from ask_sdk_core.dispatch_components import AbstractRequestHandler, AbstractExceptionHandler
from ask_sdk_model.services.directive import SendDirectiveRequest, Header, SpeakDirective

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG if os.environ.get("debug") else logging.INFO)

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
    speech = payload.get("speech") or SPEAK_ERROR
    follow_up = bool(payload.get("followUp"))
    return speech, follow_up


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


class LaunchRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("LaunchRequest")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.speak(SPEAK_WELCOME).ask(SPEAK_WELCOME).response


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

        speech, follow_up = result["value"]

        keep_open = follow_up or ask_for_further_commands
        if keep_open:
            return response_builder.speak(speech).ask(SPEAK_HELP).response
        return response_builder.speak(speech).set_should_end_session(True).response


class HelpIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.HelpIntent")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.speak(SPEAK_HELP).ask(SPEAK_HELP).response


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
