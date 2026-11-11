"""
audio_transcriber.py — Transcrição de áudio via Cloudflare Workers AI (Whisper).

Usa o modelo @cf/openai/whisper disponibilizado gratuitamente pela plataforma
Workers AI da Cloudflare. O áudio é baixado da Evolution API, convertido para
base64 e enviado ao Cloudflare Worker que executa env.AI.run('@cf/openai/whisper').
"""
import base64
import os
import requests
from config import (
    BASE_URL, INSTANCE_NAME, HEADERS,
    CF_WORKER_URL, CF_WORKER_AUTH_TOKEN,
    get_logger,
)

logger = get_logger(__name__)

# Timeout para chamadas ao Worker (transcrição costuma ser rápida)
CF_TIMEOUT = int(os.getenv("CF_TIMEOUT", "60"))

# Extensões de áudio suportadas
_AUDIO_MIMETYPES = {
    "audio/ogg; codecs=opus": ".ogg",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/aac": ".aac",
    "audio/amr": ".amr",
}


def _get_cf_headers() -> dict:
    """Retorna headers para o Cloudflare Worker."""
    headers = {"Content-Type": "application/json"}
    if CF_WORKER_AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {CF_WORKER_AUTH_TOKEN}"
    return headers


def download_audio_from_evolution(message_data: dict) -> bytes | None:
    """
    Baixa o áudio de uma mensagem usando a Evolution API.

    Tenta duas estratégias:
    1. Endpoint getBase64FromMediaMessage (converte direto pra base64)
    2. URL direta do mediaUrl (se disponível no payload)

    Retorna os bytes do áudio ou None em caso de falha.
    """
    key = message_data.get('key', {})
    msg_content = message_data.get('message', {})
    audio_msg = msg_content.get('audioMessage', {})

    # Estratégia 1: Usar endpoint da Evolution API para obter base64
    try:
        url = f"{BASE_URL}/chat/getBase64FromMediaMessage/{INSTANCE_NAME}"
        payload = {
            "message": {
                "key": key,
                "message": msg_content
            },
            "convertToMp4": False
        }
        resp = requests.post(url, headers=HEADERS, json=payload, timeout=30)
        if resp.status_code in (200, 201):
            result = resp.json()
            b64_data = result.get('base64', '') or result.get('data', '')
            if b64_data:
                # Remove prefixo data:audio/...;base64, se houver
                if ',' in b64_data:
                    b64_data = b64_data.split(',', 1)[1]
                audio_bytes = base64.b64decode(b64_data)
                logger.info(f"Áudio baixado via getBase64 ({len(audio_bytes)} bytes)")
                return audio_bytes
            logger.warning(f"getBase64 retornou sem dados: {list(result.keys())}")
        else:
            logger.warning(f"getBase64 falhou: HTTP {resp.status_code} - {resp.text[:200]}")
    except Exception as e:
        logger.warning(f"Erro no getBase64FromMediaMessage: {e}")

    # Estratégia 2: Baixar direto da URL (se disponível)
    media_url = audio_msg.get('url', '') or message_data.get('mediaUrl', '')
    if media_url:
        try:
            resp = requests.get(media_url, timeout=30)
            if resp.status_code == 200:
                logger.info(f"Áudio baixado via URL direta ({len(resp.content)} bytes)")
                return resp.content
            logger.warning(f"Download direto falhou: HTTP {resp.status_code}")
        except Exception as e:
            logger.warning(f"Erro no download direto: {e}")

    # Estratégia 3: base64 inline no próprio payload (alguns webhooks enviam assim)
    b64_inline = (
        audio_msg.get('base64', '')
        or msg_content.get('base64', '')
        or message_data.get('base64', '')
    )
    if b64_inline:
        try:
            if ',' in b64_inline:
                b64_inline = b64_inline.split(',', 1)[1]
            audio_bytes = base64.b64decode(b64_inline)
            logger.info(f"Áudio obtido via base64 inline ({len(audio_bytes)} bytes)")
            return audio_bytes
        except Exception as e:
            logger.warning(f"Erro ao decodificar base64 inline: {e}")

    logger.error("Não foi possível baixar o áudio por nenhuma estratégia")
    return None


def transcribe_audio(audio_bytes: bytes, mimetype: str = "audio/ogg; codecs=opus") -> str | None:
    """
    Transcreve áudio usando Cloudflare Workers AI (Whisper @cf/openai/whisper).

    O áudio é convertido para base64 e enviado ao Cloudflare Worker que
    executa env.AI.run('@cf/openai/whisper', { audio: buffer }).

    Args:
        audio_bytes: Bytes do arquivo de áudio
        mimetype: MIME type do áudio (informativo)

    Returns:
        Texto transcrito ou None em caso de falha
    """
    if not audio_bytes:
        return None

    if not CF_WORKER_URL:
        logger.error("CF_WORKER_URL não configurada! Defina no .env")
        return None

    try:
        # Converter áudio para base64 e enviar ao Worker
        audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

        headers = _get_cf_headers()
        payload = {"audio": audio_b64}

        response = requests.post(
            CF_WORKER_URL,
            headers=headers,
            json=payload,
            timeout=CF_TIMEOUT,
        )

        if response.status_code == 200:
            result = response.json()
            text = result.get("text", "").strip()
            if text:
                logger.info(f"Áudio transcrito via Cloudflare Whisper ({len(audio_bytes)} bytes → {len(text)} chars): {text[:80]}...")
                return text
            logger.warning("Transcrição Cloudflare retornou texto vazio")
            return None

        elif response.status_code == 401:
            logger.error("Cloudflare Worker: token de autenticação inválido (401)")
            return None

        else:
            logger.error(f"Erro na transcrição Cloudflare: HTTP {response.status_code} - {response.text[:300]}")
            return None

    except requests.exceptions.Timeout:
        logger.error(f"Timeout na transcrição Cloudflare ({CF_TIMEOUT}s)")
        return None
    except Exception as e:
        logger.error(f"Erro na transcrição: {e}", exc_info=True)
        return None


def process_audio_message(message_data: dict) -> str | None:
    """
    Pipeline completo: baixa áudio → transcreve → retorna texto.

    Args:
        message_data: Dados da mensagem do Evolution API

    Returns:
        Texto transcrito ou None se falhar
    """
    msg_content = message_data.get('message', {})
    audio_msg = msg_content.get('audioMessage', {})
    mimetype = audio_msg.get('mimetype', 'audio/ogg; codecs=opus')

    # Baixar áudio
    audio_bytes = download_audio_from_evolution(message_data)
    if not audio_bytes:
        return None

    # Verificar tamanho mínimo (evitar transcrever ruído)
    if len(audio_bytes) < 1000:  # Menos de ~1KB provavelmente é vazio
        logger.info("Áudio muito curto, ignorando")
        return None

    # Transcrever
    text = transcribe_audio(audio_bytes, mimetype)
    return text
