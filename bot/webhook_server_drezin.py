"""
webhook_server_drezin.py — Servidor Flask para webhooks do bot Drezin Tattoo.

Recebe eventos da Evolution API, processa com drezin_bot_flow, salva no DB.
"""
import threading
import time
import logging
import os
import json
import re
from flask import Flask, request, jsonify
from config import WEBHOOK_SECRET, WEBHOOK_PORT, BASE_URL, INSTANCE_NAME, HEADERS, get_logger, ADMIN_NUMBERS
from whatsapp_utils import send_safe_message
from drezin_bot_flow import process_message, get_session_data
from audio_transcriber import process_audio_message
from db import init_db, save_conversa, save_contato, save_agendamento, save_pagamento
from admin_api import admin_bp

logger = get_logger(__name__)

# Initialize database
init_db()

app = Flask(__name__)

# Register admin blueprint
app.register_blueprint(admin_bp)

# Desativa logs técnicos do Flask
logging.getLogger('werkzeug').setLevel(logging.ERROR)

# Arquivo de log
_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'webhook.log')

# URL webhook visitas (se houver integração futura)
_WEBHOOK_VISITAS_URL = os.environ.get('WEBHOOK_VISITAS_URL', 'http://localhost:5001/webhook')

# ========== DEDUPLICAÇÃO ==========
from collections import OrderedDict
_PROCESSED_MSG_IDS: OrderedDict = OrderedDict()
_DEDUP_TTL = 120
_DEDUP_MAX_SIZE = 5000

# Deduplicação por conteúdo (mesmo JID + mesmo texto em X segundos)
_CONTENT_DEDUP: OrderedDict = OrderedDict()
_CONTENT_DEDUP_TTL = 30  # segundos

def _is_duplicate_msg(msg_id: str) -> bool:
    """Retorna True se msg_id já foi processado recentemente."""
    if not msg_id:
        return False
    now = time.time()
    while _PROCESSED_MSG_IDS:
        oldest_key, oldest_time = next(iter(_PROCESSED_MSG_IDS.items()))
        if now - oldest_time > _DEDUP_TTL:
            _PROCESSED_MSG_IDS.pop(oldest_key)
        else:
            break
    if msg_id in _PROCESSED_MSG_IDS:
        return True
    _PROCESSED_MSG_IDS[msg_id] = now
    while len(_PROCESSED_MSG_IDS) > _DEDUP_MAX_SIZE:
        _PROCESSED_MSG_IDS.popitem(last=False)
    return False

def _is_duplicate_content(jid: str, body: str) -> bool:
    """Retorna True se mesmo JID enviou mesmo texto nos últimos N segundos."""
    if not jid or not body:
        return False
    now = time.time()
    key = f"{jid}:{body[:100].lower().strip()}"
    # Limpar expirados
    while _CONTENT_DEDUP:
        oldest_key, oldest_time = next(iter(_CONTENT_DEDUP.items()))
        if now - oldest_time > _CONTENT_DEDUP_TTL:
            _CONTENT_DEDUP.pop(oldest_key)
        else:
            break
    if key in _CONTENT_DEDUP:
        return True
    _CONTENT_DEDUP[key] = now
    while len(_CONTENT_DEDUP) > _DEDUP_MAX_SIZE:
        _CONTENT_DEDUP.popitem(last=False)
    return False


# ========== RATE LIMITING ==========
_JID_REPLY_LOG: dict[str, list[float]] = {}
_RATE_LIMIT_WINDOW = 30
_RATE_LIMIT_MAX = 5

def _is_rate_limited(jid: str) -> bool:
    """Retorna True se já enviamos muitas respostas a este JID recentemente."""
    now = time.time()
    if jid not in _JID_REPLY_LOG:
        _JID_REPLY_LOG[jid] = []
    _JID_REPLY_LOG[jid] = [t for t in _JID_REPLY_LOG[jid] if now - t < _RATE_LIMIT_WINDOW]
    if len(_JID_REPLY_LOG[jid]) >= _RATE_LIMIT_MAX:
        return True
    _JID_REPLY_LOG[jid].append(now)
    return False


# ========== PROTEÇÃO CONTRA INTERFERÊNCIA HUMANO ↔ BOT ==========
# Quando o humano (André) envia uma mensagem para um cliente,
# o bot para de responder aquele cliente por HUMAN_TAKEOVER_TTL segundos.
_HUMAN_TAKEOVER: dict[str, float] = {}  # jid -> timestamp quando humano interveio
_HUMAN_TAKEOVER_TTL = 2 * 60 * 60  # 2 horas em segundos

def _register_human_takeover(jid: str):
    """Registra que o humano está respondendo este JID. Bot fica mudo por 2h."""
    _HUMAN_TAKEOVER[jid] = time.time()
    logger.info(f"👤 Humano assumiu conversa com {jid} — bot silenciado por 2h")
    _log_event(f"HUMAN_TAKEOVER {jid} | bot silenciado por 2h")

def _is_human_active(jid: str) -> bool:
    """Retorna True se o humano está ativo neste JID (dentro da janela de 2h)."""
    if jid not in _HUMAN_TAKEOVER:
        return False
    elapsed = time.time() - _HUMAN_TAKEOVER[jid]
    if elapsed > _HUMAN_TAKEOVER_TTL:
        # Expirou — bot pode voltar a responder
        del _HUMAN_TAKEOVER[jid]
        logger.info(f"🔄 Tempo de takeover humano expirou para {jid} — bot reativado")
        return False
    remaining = (_HUMAN_TAKEOVER_TTL - elapsed) / 60
    logger.debug(f"👤 Humano ativo para {jid} (faltam {remaining:.0f} min)")
    return True

def _clear_human_takeover(jid: str):
    """Remove o takeover humano (permite que o bot volte a responder)."""
    if jid in _HUMAN_TAKEOVER:
        del _HUMAN_TAKEOVER[jid]
        logger.info(f"🔄 Takeover humano removido manualmente para {jid}")


# ========== HELPER FUNCTIONS ==========

def _normalize_jid(jid: str) -> str:
    """Remove device suffix de JIDs."""
    if not jid:
        return jid
    parts = jid.split('@')
    if len(parts) == 2:
        number_part = parts[0].split(':')[0]
        return f"{number_part}@{parts[1]}"
    return jid


def _log_event(msg: str):
    """Escreve em arquivo de log."""
    import datetime
    ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with open(_LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(f"{ts} {msg}\n")
        f.flush()


def _send_response_async(jid: str, texto: str, push_name: str = "Cliente"):
    """Envia resposta em thread separada (não bloqueia webhook)."""
    def _send():
        try:
            # Pequeno delay para parecer humanizado
            time.sleep(1.5)
            send_safe_message(jid, texto)
            logger.info(f"✅ Resposta enviada para {jid}")
            # Salvar conversa
            save_conversa(jid, push_name, texto, "bot")
        except Exception as e:
            logger.error(f"❌ Erro ao enviar resposta para {jid}: {e}")
    
    thread = threading.Thread(target=_send, daemon=True)
    thread.start()


# ========== WEBHOOK ENDPOINT ==========

@app.route('/webhook', methods=['POST'])
def receive_webhook():
    """
    POST /webhook
    
    Recebe eventos da Evolution API (messages.upsert).
    """
    try:
        # Validação de token (se configurado)
        if WEBHOOK_SECRET:
            token = request.headers.get('X-Webhook-Token')
            if token != WEBHOOK_SECRET:
                logger.warning(f"⚠️ Webhook recebida com token inválido: {token}")
                return jsonify({"error": "unauthorized"}), 401
        
        # Obter payload raw primeiro (para filtros e fallback)
        raw_json = request.get_data(as_text=True)
        if not raw_json:
            return jsonify({"error": "empty body"}), 400

        # ===== BLOQUEIO ABSOLUTO DE GRUPOS (antes de qualquer processamento) =====
        if '@g.us' in raw_json:
            return jsonify({"ok": True}), 200

        # Parsear JSON com fallback para escapes inválidos
        try:
            data = request.get_json()
        except Exception:
            # Evolution API às vezes envia \escape inválido — corrigir e re-parsear
            try:
                fixed = re.sub(r'\\(?!["\\bfnrtu/])', r'\\\\', raw_json)
                data = json.loads(fixed)
                logger.debug("JSON corrigido (escape inválido)")
            except Exception as e2:
                logger.error(f"❌ JSON inválido mesmo após correção: {e2}")
                logger.debug(f"Raw payload (primeiros 500 chars): {raw_json[:500]}")
                return jsonify({"error": "invalid json"}), 400

        if not data:
            return jsonify({"error": "empty body"}), 400

        # Processar evento
        event_type = data.get('event')
        
        # Apenas processar mensagens recebidas
        if event_type != 'messages.upsert':
            logger.debug(f"Evento ignorado: {event_type}")
            return jsonify({"ok": True}), 200
        
        # Extrair dados da mensagem
        message_data = data.get('data', {})
        messages = message_data.get('messages', [])

        # Evolution v2.3.7: payload vem como objeto direto, nao array
        if not messages and 'key' in message_data:
            key = message_data.get('key', {})
            remote_jid = key.get('remoteJid', '')

            # ===== FILTRAR GRUPOS ANTES DE TUDO =====
            if remote_jid.endswith('@g.us'):
                logger.debug(f"🚫 Grupo ignorado (early filter): {remote_jid}")
                return jsonify({"ok": True}), 200

            # Ignorar mensagens antigas (mais de 60s) — evita enxurrada no reconnect
            msg_timestamp = message_data.get('messageTimestamp', 0)
            if msg_timestamp:
                # messageTimestamp pode ser int ou dict ({low:..., high:...})
                if isinstance(msg_timestamp, dict):
                    msg_timestamp = msg_timestamp.get('low', 0)
                msg_timestamp = int(msg_timestamp)
                age = time.time() - msg_timestamp
                if age > 60:
                    logger.debug(f"🕐 Mensagem antiga ignorada ({age:.0f}s): {remote_jid}")
                    return jsonify({"ok": True}), 200

            # ===== DETECTAR fromMe ANTES de qualquer processamento =====
            is_from_me = key.get('fromMe', False)
            if is_from_me:
                # Mensagem enviada pelo próprio André — registrar takeover e ignorar
                normalized = _normalize_jid(remote_jid)
                if normalized and normalized.endswith('@s.whatsapp.net'):
                    _register_human_takeover(normalized)
                    logger.info(f"👤 Mensagem do próprio Drezin para {normalized} — bot silenciado 2h")
                return jsonify({"ok": True}), 200

            # ===== IGNORAR MENSAGENS DO ADMIN (Drezin) =====
            normalized_remote = _normalize_jid(remote_jid)
            remote_number = normalized_remote.split('@')[0] if normalized_remote else ''
            if remote_number in ADMIN_NUMBERS:
                logger.info(f"👤 Mensagem do admin ({remote_number}) ignorada pelo bot")
                return jsonify({"ok": True}), 200

            msg_obj = message_data.get('message', {})
            msg_type = message_data.get('messageType', '')
            body = msg_obj.get('conversation', '') or msg_obj.get('extendedTextMessage', {}).get('text', '')

            # Se for audio, transcrever via Cloudflare Whisper
            is_audio = (msg_type == 'audioMessage' or 'audioMessage' in msg_obj)
            is_image = (msg_type == 'imageMessage' or 'imageMessage' in msg_obj)
            is_audio_msg = False
            if not body and is_audio:
                logger.info(f"🎤 Audio recebido de {remote_jid}, transcrevendo...")
                is_audio_msg = True
                try:
                    body = process_audio_message(message_data) or ''
                    if body:
                        logger.info(f"🎤 Audio transcrito: {body[:80]}")
                    else:
                        logger.warning("🎤 Falha na transcricao do audio")
                        _send_response_async(
                            remote_jid,
                            "🎤 Recebemos seu áudio! O Drezin vai ouvir e te responder em breve. 🤙",
                            message_data.get('pushName', 'Cliente')
                        )
                        # Registrar takeover para o humano ouvir e responder
                        _register_human_takeover(_normalize_jid(remote_jid))
                except Exception as e:
                    logger.error(f"🎤 Erro ao transcrever audio: {e}")
                    _send_response_async(
                        remote_jid,
                        "🎤 Recebemos seu áudio! O Drezin vai ouvir e te responder em breve. 🤙",
                        message_data.get('pushName', 'Cliente')
                    )
                    _register_human_takeover(_normalize_jid(remote_jid))
                    body = ''

            # Se for imagem, pegar caption (se houver) e marcar flag
            if is_image and not body:
                caption = msg_obj.get('imageMessage', {}).get('caption', '')
                if caption:
                    body = caption
                else:
                    body = '[imagem]'  # Placeholder para imagens sem caption

            messages = [{
                'id': key.get('id', 'unknown'),
                'from': remote_jid,
                'fromMe': key.get('fromMe', False),
                'body': body,
                'pushName': message_data.get('pushName', 'Cliente'),
                'has_image': is_image,
                'is_audio': is_audio_msg,
            }]
            logger.info(f"Evolution v2.3.7 adaptado: from={remote_jid}, body={body[:50]}")
        if not messages:
            return jsonify({"ok": True}), 200
        
        for msg in messages:
            # Detectar mensagens enviadas pelo humano (fromMe)
            if msg.get('fromMe'):
                # Registrar que o humano assumiu esta conversa
                from_jid = msg.get('from', '')
                from_jid = _normalize_jid(from_jid)
                if from_jid and from_jid.endswith('@s.whatsapp.net'):
                    _register_human_takeover(from_jid)
                continue
            
            # Extrair informações
            msg_id = msg.get('id', 'unknown')
            msg_body = msg.get('body', '').strip()
            sender_jid = msg.get('from', '')
            push_name = msg.get('pushName', 'Cliente')
            has_image = msg.get('has_image', False)
            is_audio_flag = msg.get('is_audio', False)
            
            # ===== IGNORAR MENSAGENS DE GRUPOS =====
            if sender_jid.endswith('@g.us'):
                continue
            
            # Normalizar JID
            sender_jid = _normalize_jid(sender_jid)
            
            # ===== PROTEÇÃO: HUMANO ATIVO? =====
            # Se o humano (André) respondeu este cliente nas últimas 2h, bot não interfere
            if _is_human_active(sender_jid):
                logger.info(f"👤 Bot silenciado para {sender_jid} (humano ativo). Ignorando.")
                _log_event(f"HUMAN_ACTIVE_SKIP {sender_jid} | msg={msg_body[:60]}")
                continue
            
            # Ignorar duplicatas (por ID)
            if _is_duplicate_msg(msg_id):
                logger.debug(f"⚠️ Mensagem duplicada ignorada (ID): {msg_id}")
                continue
            
            # Ignorar duplicatas (por conteúdo — mesmo JID + texto em 30s)
            if _is_duplicate_content(sender_jid, msg_body):
                logger.debug(f"⚠️ Mensagem duplicada ignorada (conteúdo): {sender_jid}")
                continue
            
            # Rate limiting
            if _is_rate_limited(sender_jid):
                logger.warning(f"⚠️ Rate limit atingido para {sender_jid}")
                continue
            
            if not msg_body and not has_image:
                logger.debug(f"Mensagem vazia recebida de {sender_jid} (pode ser sticker, etc)")
                continue
            
            logger.info(f"📨 Mensagem recebida de {push_name} ({sender_jid}): {msg_body[:100]}")
            _log_event(f"MSG_IN {sender_jid} | {push_name} | {msg_body[:100]}")
            
            # Salvar contato
            save_contato(sender_jid, push_name)
            
            # Salvar mensagem do usuário
            save_conversa(sender_jid, push_name, msg_body, "usuario")
            
            # Processar com bot_flow
            resposta = process_message(sender_jid, msg_body, push_name, is_audio=is_audio_flag)
            
            # Se o bot transferiu para humano, ativar takeover de 2h
            session_data = get_session_data(sender_jid)
            if session_data and session_data.get('state') == 'humano':
                _register_human_takeover(sender_jid)
            
            # Se há resposta, enviar
            if resposta:
                logger.info(f"🤖 Resposta do bot: {resposta[:100]}")
                _log_event(f"MSG_OUT {sender_jid} | {resposta[:100]}")
                
                # Enviar resposta em thread (não bloqueia webhook)
                _send_response_async(sender_jid, resposta, push_name)
            else:
                logger.info(f"ℹ️ Bot não respondeu (estado: humano ou erro)")
                _log_event(f"NO_RESPONSE {sender_jid}")
        
        return jsonify({"ok": True}), 200
    
    except Exception as e:
        logger.error(f"❌ Erro ao processar webhook: {e}", exc_info=True)
        _log_event(f"ERROR {str(e)}")
        return jsonify({"error": str(e)}), 500


# ========== ADMIN ENDPOINTS ==========

@app.route('/api/admin/sessions/<jid>', methods=['GET'])
def get_session_info(jid: str):
    """GET /api/admin/sessions/{jid} — Informações de sessão do contato."""
    try:
        data = get_session_data(jid)
        if data:
            return jsonify({'success': True, 'session': data})
        else:
            return jsonify({'success': False, 'error': 'Sessão não encontrada'}), 404
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin/test-send', methods=['POST'])
def test_send_message():
    """
    POST /api/admin/test-send
    
    Envia mensagem de teste (para verificar se bot está funcionando).
    
    Body JSON:
    {
        "jid": "5511999999999@s.whatsapp.net",
        "message": "Olá! Teste de mensagem."
    }
    """
    try:
        data = request.get_json()
        jid = data.get('jid')
        message = data.get('message')
        
        if not jid or not message:
            return jsonify({'success': False, 'error': 'jid e message obrigatórios'}), 400
        
        send_safe_message(jid, message)
        logger.info(f"✅ Mensagem de teste enviada para {jid}")
        
        return jsonify({'success': True, 'message': 'Mensagem enviada'})
    
    except Exception as e:
        logger.error(f"Erro ao enviar mensagem de teste: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin/human-takeover', methods=['GET'])
def list_human_takeovers():
    """GET /api/admin/human-takeover — Lista JIDs com humano ativo."""
    now = time.time()
    active = {}
    for jid, ts in list(_HUMAN_TAKEOVER.items()):
        elapsed = now - ts
        if elapsed < _HUMAN_TAKEOVER_TTL:
            active[jid] = {
                'since': time.strftime('%H:%M:%S', time.localtime(ts)),
                'remaining_min': round((_HUMAN_TAKEOVER_TTL - elapsed) / 60, 1),
            }
        else:
            del _HUMAN_TAKEOVER[jid]
    return jsonify({'success': True, 'human_active': active, 'count': len(active)})


@app.route('/api/admin/human-takeover/<path:jid>', methods=['DELETE'])
def clear_human_takeover(jid: str):
    """DELETE /api/admin/human-takeover/{jid} — Remove takeover e reativa bot."""
    _clear_human_takeover(jid)
    return jsonify({'success': True, 'message': f'Bot reativado para {jid}'})


# ========== HEALTH CHECK ==========

@app.route('/health', methods=['GET'])
def health():
    """GET /health — Status do servidor."""
    return jsonify({
        'status': 'ok',
        'service': 'Drezin Tattoo Bot',
        'version': '1.0.0'
    })


@app.route('/', methods=['GET'])
def index():
    """Página inicial (para verificar se servidor está rodando)."""
    return jsonify({
        'service': 'Drezin Tattoo Bot',
        'webhook': '/webhook',
        'api': '/api/admin/*',
        'status': 'running'
    })


# ========== INICIALIZAÇÃO ==========

if __name__ == '__main__':
    logger.info("🚀 Iniciando Drezin Tattoo Bot Webhook Server")
    logger.info(f"📡 Webhook URL: http://0.0.0.0:{WEBHOOK_PORT}/webhook")
    logger.info(f"🔐 Evolution API: {BASE_URL}")
    logger.info(f"🤖 Instância: {INSTANCE_NAME}")
    
    # Tentar usar Waitress para produção
    try:
        from waitress import serve
        logger.info("✅ Usando Waitress (produção)")
        serve(app, host='0.0.0.0', port=WEBHOOK_PORT, threads=4)
    except ImportError:
        logger.warning("⚠️ Waitress não instalado, usando Flask dev server")
        app.run(host='0.0.0.0', port=WEBHOOK_PORT, debug=False)
