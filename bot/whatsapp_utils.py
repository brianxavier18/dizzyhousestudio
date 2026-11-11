import time
import random
import requests
import os
import logging as _logging
from config import BASE_URL, API_KEY, INSTANCE_NAME, HEADERS, get_logger

logger = get_logger(__name__)

# FileHandler para garantir log em arquivo
_fh = _logging.FileHandler(os.path.join(os.path.dirname(__file__), 'webhook.log'), encoding='utf-8')
_fh.setLevel(_logging.DEBUG)
_fh.setFormatter(_logging.Formatter('%(asctime)s [%(levelname)s] %(name)s: %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
logger.addHandler(_fh)

# Log direto em arquivo (bypass logging framework)
_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'webhook_events.log')

def _log_send(msg: str):
    """Log direto em arquivo para debug de envio."""
    import datetime
    ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    try:
        with open(_LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(f"{ts} [SEND] {msg}\n")
            f.flush()
    except Exception:
        pass


def _extract_phone_number(jid: str) -> str:
    """
    Extrai o numero de telefone puro de um JID.
    Ex: '5511999999999@s.whatsapp.net' -> '5511999999999'
    Se for @lid, retorna o JID completo (para tentativa direta).
    """
    if '@' in jid:
        number_part = jid.split('@')[0].split(':')[0]
        if jid.endswith('@s.whatsapp.net'):
            return number_part
    return jid


def get_human_delay(text: str) -> float:
    """
    Calcula quanto tempo uma pessoa levaria para digitar a mensagem.
    Regra: ~0.15 segundos por caractere, com minimo de 2s e variacao aleatoria.
    """
    base_delay = len(text) * 0.15
    delay = max(2.0, min(base_delay, 12.0))
    jitter = random.uniform(0.85, 1.15)
    return delay * jitter


def send_typing_presence(remote_jid: str, duration_sec: float):
    """
    Avisa ao WhatsApp que estamos 'Digitando...' (composing).
    Compativel com Evolution API v2.x.
    """
    url = f"{BASE_URL}/chat/sendPresence/{INSTANCE_NAME}"
    # Extrair numero puro (sem @s.whatsapp.net ou @lid)
    number = remote_jid.split('@')[0] if '@' in remote_jid else remote_jid
    payload = {
        "number": number,
        "presence": "composing",
        "delay": int(duration_sec * 1000)
    }
    try:
        requests.post(url, headers=HEADERS, json=payload, timeout=10)
    except requests.exceptions.ConnectionError:
        logger.debug(f"Erro de conexao ao enviar presenca para {remote_jid}")
    except requests.exceptions.Timeout:
        logger.debug(f"Timeout ao enviar presenca para {remote_jid}")
    except requests.exceptions.RequestException as e:
        logger.debug(f"Erro ao enviar presenca: {e}")


def _try_send_text(number: str, text: str) -> tuple[bool, str]:
    """
    Tenta enviar mensagem de texto. Retorna (sucesso, detalhes).
    Compativel com Evolution API v2.x.
    """
    url = f"{BASE_URL}/message/sendText/{INSTANCE_NAME}"

    # Evolution API v2 usa payload simplificado: {"number": "...", "text": "..."}
    payload = {
        "number": number,
        "text": text
    }
    try:
        response = requests.post(url, headers=HEADERS, json=payload, timeout=15)
        if response.status_code in [200, 201]:
            return True, f"OK ({response.status_code})"
        else:
            # Fallback: tenta formato v1 caso v2 falhe
            payload_v1 = {
                "number": number,
                "textMessage": {"text": text}
            }
            response2 = requests.post(url, headers=HEADERS, json=payload_v1, timeout=15)
            if response2.status_code in [200, 201]:
                return True, f"OK_v1 ({response2.status_code})"
            return False, f"HTTP {response.status_code}: {response.text[:200]}"
    except requests.exceptions.ConnectionError:
        return False, "ConnectionError"
    except requests.exceptions.Timeout:
        return False, "Timeout"
    except requests.exceptions.RequestException as e:
        return False, str(e)


def send_safe_message(remote_jid: str, text: str):
    """
    Envia mensagem com comportamento anti-banimento (humanizado).
    Compativel com Evolution API v2.x.
    Na v2, o ideal e enviar o numero puro (sem @s.whatsapp.net).
    """
    if not remote_jid or not text:
        return

    delay = get_human_delay(text)
    logger.info(f"[Modo Humano] 'Digitando' por {delay:.1f}s para {remote_jid}...")

    send_typing_presence(remote_jid, delay)
    time.sleep(delay)

    # Extrair numero puro para v2 (sem @s.whatsapp.net ou @lid)
    phone_pure = remote_jid.split('@')[0].split(':')[0] if '@' in remote_jid else remote_jid

    # Estrategia 1 (v2): Enviar com numero puro (formato preferido da v2)
    _log_send(f"TENTATIVA_1: number={phone_pure} (v2 puro)")
    success, detail = _try_send_text(phone_pure, text)
    if success:
        logger.info(f"Enviado para {phone_pure}: {text[:60]}...")
        _log_send(f"OK: {phone_pure}")
        return

    logger.warning(f"Falha v2 puro {phone_pure}: {detail}")
    _log_send(f"FALHA_1: {phone_pure} => {detail}")

    # Estrategia 2: Enviar com JID completo (@s.whatsapp.net)
    if remote_jid.endswith('@s.whatsapp.net'):
        _log_send(f"TENTATIVA_2: number={remote_jid} (jid completo)")
        success, detail = _try_send_text(remote_jid, text)
        if success:
            logger.info(f"Enviado via JID {remote_jid}: {text[:60]}...")
            _log_send(f"OK_JID: {remote_jid}")
            return
        logger.warning(f"Falha JID {remote_jid}: {detail}")
        _log_send(f"FALHA_2: {remote_jid} => {detail}")

    # Estrategia 3: Se era @lid, tentar enviar com o LID completo
    elif remote_jid.endswith('@lid'):
        _log_send(f"TENTATIVA_2: number={remote_jid} (lid completo)")
        success, detail = _try_send_text(remote_jid, text)
        if success:
            logger.info(f"Enviado via LID {remote_jid}: {text[:60]}...")
            _log_send(f"OK_LID: {remote_jid}")
            return
        logger.warning(f"Falha LID {remote_jid}: {detail}")
        _log_send(f"FALHA_2: {remote_jid} => {detail}")

    logger.error(f"TODAS AS TENTATIVAS FALHARAM para {remote_jid}. Mensagem nao enviada.")
    _log_send(f"TODAS_FALHAS: {remote_jid} | msg={text[:80]}")
