"""
drezin_bot_flow.py — Fluxo de pré-atendimento humanizado do Dizzy House Studio.

A primeira mensagem é do DREZIN pessoalmente, dizendo que está ocupado
e que seu assistente vai fazer algumas perguntas.
O assistente coleta dados do cliente de forma natural (sem menus numerados).
A partir do fechamento, o Dré assume com templates prontos.

Fluxo principal (cliente novo):
  novo → aguardando_resposta → cliente_tipo → origem → briefing → investimento → organizacao → humano

Fluxo principal (cliente da casa):
  novo → aguardando_resposta → cliente_tipo → briefing → investimento → organizacao → humano

Fluxos alternativos:
  - Já tem orçamento/agendamento: → humano (Dré assume direto)
  - Outro assunto: → redireciona pro Instagram
  - Dúvidas: duvidas → duvidas_livre → humano
  - Cobertura: cobertura → humano
  - Site: site_confirma → humano
  - Urgência: → humano
"""
import json
import re
import time
import os
import random
from datetime import datetime
from config import get_logger

logger = get_logger(__name__)

# Carrega as respostas
_RESPONSES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'drezin_responses.json')
with open(_RESPONSES_FILE, 'r', encoding='utf-8') as _f:
    RESPONSES: dict = json.load(_f)

# ========== ESTADOS DO FLUXO PRINCIPAL ==========
STATE_NOVO = "novo"
STATE_AGUARDANDO_RESPOSTA = "aguardando_resposta"
STATE_CLIENTE_TIPO = "cliente_tipo"
STATE_ORIGEM = "origem"
STATE_BRIEFING = "briefing"
STATE_INVESTIMENTO = "investimento"
STATE_ORGANIZACAO = "organizacao"
STATE_HUMANO = "humano"

# Fluxos alternativos
STATE_DUVIDAS = "duvidas"
STATE_DUVIDAS_LIVRE = "duvidas_livre"
STATE_COBERTURA = "cobertura"
STATE_SITE_CONFIRMA = "site_confirma"
STATE_OUTROS_ASSUNTOS = "outros_assuntos"
STATE_TRANSBORDO = "transbordo"

# Backward compatibility
STATE_LOCAL = STATE_BRIEFING
STATE_FOTO_REFERENCIA = STATE_BRIEFING
STATE_FOTO_CORPO = STATE_BRIEFING
STATE_TAMANHO = STATE_BRIEFING
STATE_ESTILO = STATE_BRIEFING
STATE_COMBO = STATE_BRIEFING
STATE_RESUMO = STATE_INVESTIMENTO
STATE_DATA = STATE_HUMANO
STATE_PERIODO = STATE_HUMANO
STATE_HORARIO = STATE_HUMANO
STATE_PAGAMENTO_SINAL = STATE_HUMANO
STATE_COMPROVANTE = STATE_HUMANO
STATE_PAGAMENTO_RESTANTE = STATE_HUMANO
STATE_CONCLUIDO = STATE_HUMANO
STATE_CONFIRMAR_AGENDAMENTO = STATE_HUMANO
STATE_AGUARDANDO = STATE_HUMANO
STATE_COBERTURA_FOTO = STATE_COBERTURA
STATE_COBERTURA_CORPO = STATE_COBERTURA
STATE_COBERTURA_RESUMO = STATE_COBERTURA
STATE_COBERTURA_DATA = STATE_HUMANO
STATE_COBERTURA_PERIODO = STATE_HUMANO
STATE_COBERTURA_HORARIO = STATE_HUMANO
STATE_COBERTURA_PAGAMENTO = STATE_HUMANO

# ========== SESSÕES ==========
_sessions: dict[str, dict] = {}
TIMEOUT_MINUTOS = 30

# ========== PALAVRAS-CHAVE DE DETECÇÃO ==========

_WAITING_KEYWORDS = [
    "jaja", "ja ja", "já já", "correria", "to no trampo", "tô no trampo",
    "mais tarde", "depois", "pera", "perai", "peraí", "um momento",
    "um minuto", "espera", "to ocupado", "tô ocupado", "mais tarde respondo",
    "depois respondo", "volto ja", "volto já", "daqui a pouco",
    "to na correria", "tô na correria", "agora não dá", "agora nao da",
    "to trabalhando", "tô trabalhando", "vou responder depois",
    "calma ai", "calma aí", "sem pressa", "tranquilo",
]

_CASUAL_KEYWORDS = [
    "kkk", "kkkk", "kkkkk", "kkkkkk", "haha", "hahaha", "rsrs", "rsrsrs",
    "show", "top", "massa", "legal", "tmj", "valeu", "vlw", "obg", "obrigado",
    "obrigada", "blz", "beleza", "pd crer", "pode crer", "dahora", "maneiro",
    "suave", "de boa", "firmeza", "fechou", "isso ai", "isso aí",
    "boa", "boua", "bom demais", "perfeito", "sensacional",
]

_EMOJI_PATTERN = re.compile(
    r'^[\U0001F600-\U0001F64F\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF'
    r'\U00002702-\U000027B0\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F'
    r'\U0001FA70-\U0001FAFF\U00002600-\U000026FF\U0000FE00-\U0000FE0F'
    r'\u200d\u2640\u2642\uFE0F\U0001F300-\U0001F5FF]+$'
)


# ========== FUNÇÕES AUXILIARES ==========

def _get_session(jid: str, push_name: str = "Desconhecido") -> dict:
    now = time.time()
    sess = _sessions.get(jid)

    if sess and (now - sess["ts"]) > TIMEOUT_MINUTOS * 60:
        logger.info(f"Sessão expirada para {jid}. Reiniciando.")
        sess = None

    if not sess:
        sess = {
            "state": STATE_NOVO,
            "ts": now,
            "push_name": push_name,
            "meta": {
                "cliente_tipo": None,
                "origem": None,
                "indicacao": None,
                "primeira_tattoo": None,
                "briefing_texto": [],
                "briefing_audio": [],
                "fotos_recebidas": 0,
                "investimento_cliente": None,
                "origem_contato": "whatsapp",
                "site_data": None,
                "site_periodo": None,
                "site_projeto": None,
            }
        }
        _sessions[jid] = sess
    else:
        sess["ts"] = now

    if push_name and push_name != "Desconhecido":
        sess["push_name"] = push_name

    return sess


def _fmt(template: str, nome: str = "amigo(a)", **kwargs) -> str:
    result = template.replace("{nome}", nome)
    for key, value in kwargs.items():
        result = result.replace(f"{{{key}}}", str(value))
    return result


def _is_waiting_message(msg_lower: str) -> bool:
    return any(kw in msg_lower for kw in _WAITING_KEYWORDS)


def _is_casual_message(msg: str, msg_lower: str) -> bool:
    if len(msg) > 30:
        return False
    if _EMOJI_PATTERN.match(msg.strip()):
        return True
    clean = msg_lower.strip()
    for kw in _CASUAL_KEYWORDS:
        if clean == kw or clean.startswith(kw + " ") or clean.endswith(" " + kw):
            return True
    return False


def _is_photo_message(msg: str) -> bool:
    return msg.strip() == "" or msg.strip().lower() in [
        "[imagem]", "[image]", "[foto]", "[photo]"
    ]


def _random_aguardo() -> str:
    opcoes = RESPONSES.get("resposta_aguardo", ["Showww fico no aguardo 🤙"])
    return random.choice(opcoes)


def _random_casual() -> str:
    opcoes = RESPONSES.get("resposta_casual", ["Showww 🤙"])
    return random.choice(opcoes)


# ========== NORMALIZAÇÃO DE ÁUDIO ==========

_NUMBERS_MAP = {
    "um": "1", "uma": "1", "primeiro": "1", "primeira": "1",
    "dois": "2", "duas": "2", "segundo": "2", "segunda": "2",
    "três": "3", "tres": "3", "terceiro": "3", "terceira": "3",
    "quatro": "4", "quarto": "4", "quarta": "4",
    "cinco": "5", "quinto": "5", "quinta": "5",
}

_FILLER_WORDS = [
    "então", "entao", "bom", "assim", "tipo", "né", "ne", "tá", "ta",
    "aí", "ai", "hum", "hmm", "ah", "eh", "oh", "é", "aí ó",
    "olha", "olha só", "por favor",
]


def _normalize_audio_text(text: str) -> str:
    if not text:
        return text
    original = text.strip()
    cleaned = original.lower()
    cleaned = re.sub(r'[.,;:!?\(\)\[\]"\']', ' ', cleaned)
    for filler in sorted(_FILLER_WORDS, key=len, reverse=True):
        cleaned = re.sub(r'\b' + re.escape(filler) + r'\b', ' ', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    if len(cleaned) < 1:
        return original.lower()
    return cleaned


# ========== FAQ / DÚVIDAS ==========

_FAQ_RULES = [
    (["preço", "preco", "precos", "preços", "quanto custa", "tabela de preço",
      "valor", "valores", "quanto é", "quanto e", "custa quanto"],
     "precos"),
    (["pix", "pagamento", "pagar", "sinal", "parcela", "dinheiro", "cartão",
      "cartao", "chave pix", "forma de pagamento", "como pago", "como pagar"],
     "precos"),
    (["horário", "horario", "horários", "horarios", "hora", "que horas",
      "funcionamento", "funciona", "atende", "quando abre", "quando fecha",
      "aberto", "fechado", "domingo", "sábado", "sabado", "segunda", "agenda",
      "dia de atendimento"],
     "horarios"),
    (["endereço", "endereco", "localização", "localizacao", "onde fica",
      "como chegar", "mapa", "maps", "google maps", "rua", "bairro",
      "niterói", "niteroi", "instagram", "contato", "telefone",
      "whatsapp", "site", "petrópolis", "petropolis", "rua teresa"],
     "localizacao"),
    (["cuidado", "cuidados", "antes", "depois", "cicatrização", "cicatrizacao",
      "pomada", "bepantol", "protetor solar", "sol", "piscina", "mar",
      "coçar", "lavar", "álcool", "alcool", "bebida", "jejum"],
     "cuidados"),
    (["cancelar", "cancelamento", "remarcar", "reagendar", "atraso",
      "alterar", "mudar data", "trocar data", "trocar horário",
      "trocar horario", "voucher", "dizzycorporation"],
     "agendamento"),
]


def _responder_duvida_automatica(msg_lower: str) -> str | None:
    for keywords, resposta_key in _FAQ_RULES:
        for kw in keywords:
            if kw in msg_lower:
                resp = RESPONSES.get("duvidas", {}).get(resposta_key)
                if resp:
                    return resp
    return None


# ========== PARSER DE MENSAGEM DO SITE ==========

def _parse_site_message(text: str) -> dict | None:
    if "nome:" not in text.lower() or "data:" not in text.lower():
        return None

    dados = {}
    lines = text.split('\n')

    # Extrair dados da primeira linha se começar com "SITE:"
    if lines and lines[0].strip().startswith("SITE:"):
        first_line = lines[0].strip()[5:].strip()  # Remove "SITE:"
        parts = [p.strip() for p in first_line.split(',')]
        if len(parts) >= 3:
            dados['tipo'] = parts[0]  # cliente_novo
            dados['local'] = parts[1]  # costela
            dados['projeto'] = parts[2]  # complexidade

    # Extrair dados das outras linhas
    for line in lines:
        line = line.strip()
        if ':' in line:
            key, _, val = line.partition(':')
            key = key.strip().lower()
            val = val.strip()
            if key == 'nome':
                dados['nome'] = val
            elif key == 'data':
                dados['data'] = val
            elif key == 'horário' or key == 'horario':
                dados['horario'] = val
            elif 'per' in key:
                dados['periodo'] = val
            elif key == 'tipo':
                dados['tipo'] = val
            elif key == 'projeto':
                dados['projeto'] = val

    if 'nome' in dados and 'data' in dados:
        return dados
    return None


# ========== LÓGICA PRINCIPAL ==========

def process_message(jid: str, text: str, push_name: str = "Desconhecido",
                    is_audio: bool = False) -> str | None:
    """
    Processa a mensagem e retorna a resposta do bot.
    Retorna None quando o bot deve silenciar (human takeover).
    """
    sess = _get_session(jid, push_name)
    nome = sess["push_name"]
    msg = text.strip()

    if is_audio and msg:
        msg_original = msg
        msg = _normalize_audio_text(msg)
        if msg != msg_original.lower():
            logger.info(f"🎤 Áudio normalizado: '{msg_original[:60]}' → '{msg[:60]}'")

    msg_lower = msg.lower()
    meta = sess["meta"]

    # ═══════════════════════════════════════════════════════
    # DETECTORES GLOBAIS (qualquer estado exceto HUMANO)
    # ═══════════════════════════════════════════════════════

    # Pedir atendente humano
    _atendente_kw = [
        "atendente", "humano", "falar com alguém", "falar com alguem",
        "falar com o dre", "falar com dre", "falar com drezin",
        "chamar o dre", "chamar dre", "quero falar com gente",
    ]
    if any(kw in msg_lower for kw in _atendente_kw):
        sess["state"] = STATE_HUMANO
        return RESPONSES["transbordo"]

    # Mensagem de espera (não avança estado)
    if sess["state"] not in (STATE_NOVO, STATE_AGUARDANDO_RESPOSTA, STATE_HUMANO):
        if _is_waiting_message(msg_lower):
            return _random_aguardo()

    # Foto recebida
    if _is_photo_message(msg):
        meta["fotos_recebidas"] = meta.get("fotos_recebidas", 0) + 1
        if sess["state"] == STATE_AGUARDANDO_RESPOSTA:
            # Cliente mandou foto junto com/após o primeiro contato
            # Agradece e faz a transição pro assistente
            sess["state"] = STATE_CLIENTE_TIPO
            return RESPONSES["foto_recebida"] + "\n\n" + RESPONSES["transicao_atendente"]
        elif sess["state"] != STATE_HUMANO:
            return RESPONSES["foto_recebida"]
        return None

    # Mensagem casual (não avança estado)
    if sess["state"] not in (STATE_NOVO, STATE_AGUARDANDO_RESPOSTA, STATE_HUMANO):
        if _is_casual_message(msg, msg_lower):
            return _random_casual()

    # ═══════════════════════════════════════════════════════
    # MÁQUINA DE ESTADOS
    # ═══════════════════════════════════════════════════════

    # ========== NOVO (Drezin saúda pessoalmente) ==========
    if sess["state"] == STATE_NOVO:
        # Mensagem do site
        site_data = _parse_site_message(msg)
        if site_data:
            logger.info(f"🌐 Reserva do site detectada de {jid}: {site_data}")
            meta["origem_contato"] = "site"
            meta["site_data"] = site_data.get("data")
            meta["site_periodo"] = site_data.get("periodo", "A definir")
            meta["site_projeto"] = site_data.get("projeto", "")
            if site_data.get("nome"):
                sess["push_name"] = site_data["nome"]
                nome = site_data["nome"]
            sess["state"] = STATE_SITE_CONFIRMA
            return _fmt(
                RESPONSES["site_confirmacao"],
                nome=nome,
                data=meta.get("site_data", ""),
                periodo=meta.get("site_periodo", ""),
                projeto=meta.get("site_projeto", "-"),
            )

        # Urgência
        _urgencia_kw = ["urgência", "urgencia", "urgente", "chamar agora",
                        "preciso pra hoje", "preciso pra agora", "encaixe"]
        if any(kw in msg_lower for kw in _urgencia_kw):
            sess["state"] = STATE_HUMANO
            return RESPONSES["urgencia"]

        # Coleta texto inicial como briefing (caso já mande info da tattoo)
        if msg and len(msg) > 5:
            meta["briefing_texto"].append(msg)
            if is_audio:
                meta["briefing_audio"].append(msg)

        # Drezin saúda pessoalmente
        sess["state"] = STATE_AGUARDANDO_RESPOSTA
        return _fmt(RESPONSES["boas_vindas"], nome)

    # ========== AGUARDANDO RESPOSTA (cliente respondeu ao Drezin) ==========
    elif sess["state"] == STATE_AGUARDANDO_RESPOSTA:
        # O cliente respondeu a saudação do Drezin.
        # Pode ser "ok sem pressa", referência, audio, qualquer coisa.
        # Coletamos a info e fazemos a transição pro assistente.
        if msg:
            meta["briefing_texto"].append(msg)
            if is_audio:
                meta["briefing_audio"].append(msg)

        # Assistente assume e pergunta: novo ou cliente da casa?
        sess["state"] = STATE_CLIENTE_TIPO
        return RESPONSES["transicao_atendente"]

    # ========== SITE_CONFIRMA ==========
    elif sess["state"] == STATE_SITE_CONFIRMA:
        _corrige_kw = ["não", "nao", "errado", "corrigir", "tá errado", "ta errado", "trocar"]
        if any(kw in msg_lower for kw in _corrige_kw):
            sess["state"] = STATE_HUMANO
            return RESPONSES["transbordo"]
        sess["state"] = STATE_LOCAL
        return RESPONSES["site_confirmado"]

    # ========== CLIENTE_TIPO (novo ou da casa?) ==========
    elif sess["state"] == STATE_CLIENTE_TIPO:
        _novo_kw = [
            "novo", "nova", "novo cliente", "sou novo", "sou nova",
            "primeira vez", "nunca fiz", "quero fazer", "quero tatuar",
            "fazer uma tattoo", "fazer tatuagem", "primeira tattoo",
            "primeira tatuagem", "não tenho", "nao tenho", "quero uma",
            "quero um", "to querendo", "tô querendo", "chegando agora",
            "sou novato", "sou novata",
        ]
        _casa_kw = [
            "casa", "cliente da casa", "da casa", "já fiz", "ja fiz",
            "já sou", "ja sou", "voltei", "voltar", "de novo",
            "outra tattoo", "mais uma", "já tatuei", "ja tatuei",
            "já fiz com", "ja fiz com", "voltando", "fiz com o dre",
            "fiz com dre", "fiz com drezin", "sou da casa",
        ]
        _duvida_kw = [
            "dúvida", "duvida", "duvidas", "dúvidas",
            "pergunta", "perguntar", "saber", "informação", "informacao",
        ]
        _cobertura_kw = [
            "reforma", "cobertura", "cobrir", "cover up", "coverup",
            "reformar", "cobrir tattoo", "cobrir tatuagem",
        ]
        _ja_orcou_kw = [
            "já orçou", "ja orçou", "já passei orçamento", "ja passei orcamento",
            "já conversei com o dre", "ja conversei com o dre",
            "quero marcar", "quero agendar", "marcar sessão", "marcar sessao",
            "agendar sessão", "agendar sessao", "já tenho orçamento",
            "ja tenho orcamento", "já agendei", "ja agendei",
        ]
        _ja_agendado_kw = [
            "já agendado", "ja agendado", "tenho agendamento",
            "minha sessão", "minha sessao", "meu agendamento",
            "tá marcado", "ta marcado", "já marquei", "ja marquei",
        ]
        _outro_kw = [
            "outro assunto", "não é tattoo", "nao é tattoo",
            "não é tatuagem", "nao é tatuagem", "diferente",
            "outro", "outros",
        ]

        # Cliente novo → pergunta origem
        if any(kw in msg_lower for kw in _novo_kw):
            meta["cliente_tipo"] = "novo"
            sess["state"] = STATE_ORIGEM
            return RESPONSES["cliente_novo_origem"]

        # Cliente da casa → vai direto pro briefing
        elif any(kw in msg_lower for kw in _casa_kw):
            meta["cliente_tipo"] = "casa"
            sess["state"] = STATE_BRIEFING
            return RESPONSES["cliente_da_casa"]

        # Já tem orçamento → Dré assume
        elif any(kw in msg_lower for kw in _ja_orcou_kw):
            sess["state"] = STATE_HUMANO
            return RESPONSES["ja_orcamento"]

        # Já tem agendamento → Dré assume
        elif any(kw in msg_lower for kw in _ja_agendado_kw):
            sess["state"] = STATE_HUMANO
            return RESPONSES["ja_agendado"]

        # Dúvida → FAQ
        elif any(kw in msg_lower for kw in _duvida_kw):
            sess["state"] = STATE_DUVIDAS
            return RESPONSES["duvidas"]["inicio"]

        # Cobertura → fluxo especial
        elif any(kw in msg_lower for kw in _cobertura_kw):
            meta["cliente_tipo"] = meta.get("cliente_tipo") or "novo"
            sess["state"] = STATE_COBERTURA
            return RESPONSES["cobertura_intro"]

        # Outro assunto → redireciona pro Instagram
        elif any(kw in msg_lower for kw in _outro_kw):
            sess["state"] = STATE_HUMANO
            return RESPONSES["outro_assunto"]

        else:
            # Tentar detectar intenção de tattoo
            _tattoo_kw = ["tattoo", "tatuagem", "tatuar", "tatu", "ink",
                          "desenho", "arte", "sessão", "sessao", "orçamento",
                          "orcamento"]
            if any(kw in msg_lower for kw in _tattoo_kw):
                meta["cliente_tipo"] = "novo"
                sess["state"] = STATE_ORIGEM
                return RESPONSES["cliente_novo_origem"]

            # FAQ automático
            resp = _responder_duvida_automatica(msg_lower)
            if resp:
                return resp

            return RESPONSES["erro_generico"]

    # ========== ORIGEM (como conheceu o Drezin?) ==========
    elif sess["state"] == STATE_ORIGEM:
        if msg:
            meta["briefing_texto"].append(msg)
            if is_audio:
                meta["briefing_audio"].append(msg)

        # Extrair dados de origem
        if any(kw in msg_lower for kw in ["insta", "instagram", "ig", "rede social"]):
            meta["origem"] = "Instagram"
        elif any(kw in msg_lower for kw in ["indicação", "indicacao", "indicou",
                                             "amigo", "amiga", "parente", "conhecido"]):
            meta["origem"] = "Indicação"

        if any(kw in msg_lower for kw in ["primeira", "nunca", "não tenho", "nao tenho",
                                           "será a primeira", "sera a primeira",
                                           "vai ser a primeira", "nunca fiz"]):
            meta["primeira_tattoo"] = True
        elif any(kw in msg_lower for kw in ["já tenho", "ja tenho", "tenho outras",
                                             "tenho uma", "tenho algumas",
                                             "já fiz", "ja fiz", "possuo"]):
            meta["primeira_tattoo"] = False

        # Avança para briefing (pergunta sobre estilo)
        sess["state"] = STATE_BRIEFING
        # Se já mandou foto, não precisa pedir de novo
        if meta.get("fotos_recebidas", 0) > 0:
            return RESPONSES["briefing"]
        else:
            return RESPONSES["briefing"] + "\n\n" + RESPONSES["foto_pedido"]

    # ========== BRIEFING (estilo e detalhes da tattoo) ==========
    elif sess["state"] == STATE_BRIEFING:
        if msg:
            meta["briefing_texto"].append(msg)
            if is_audio:
                meta["briefing_audio"].append(msg)

        # Avança para investimento + info de pagamento
        sess["state"] = STATE_INVESTIMENTO
        pgto_key = ("pagamento_info_casa"
                     if meta.get("cliente_tipo") == "casa"
                     else "pagamento_info_novo")
        return RESPONSES["investimento"] + "\n\n" + RESPONSES[pgto_key]

    # ========== INVESTIMENTO (expectativa de orçamento) ==========
    elif sess["state"] == STATE_INVESTIMENTO:
        if msg:
            meta["investimento_cliente"] = msg
            meta["briefing_texto"].append(f"[Investimento] {msg}")

        # Finaliza triagem → organiza e redireciona
        sess["state"] = STATE_ORGANIZACAO
        return RESPONSES["organizacao"] + "\n\n" + RESPONSES["engajamento"]

    # ========== ORGANIZACAO (triagem completa) ==========
    elif sess["state"] == STATE_ORGANIZACAO:
        sess["state"] = STATE_HUMANO
        if msg:
            meta["briefing_texto"].append(f"[Pós-triagem] {msg}")
        return _random_casual() + "\nO Dré já vai te responder! 🤙"

    # ========== COBERTURA ==========
    elif sess["state"] == STATE_COBERTURA:
        if msg:
            meta["briefing_texto"].append(f"[Cobertura] {msg}")
        sess["state"] = STATE_HUMANO
        return RESPONSES["cobertura_recebido"]

    # ========== DÚVIDAS ==========
    elif sess["state"] == STATE_DUVIDAS:
        resp = _responder_duvida_automatica(msg_lower)
        if resp:
            return resp
        sess["state"] = STATE_DUVIDAS_LIVRE
        return RESPONSES["duvidas"]["outra"]

    # ========== DÚVIDAS TEXTO LIVRE ==========
    elif sess["state"] == STATE_DUVIDAS_LIVRE:
        resp = _responder_duvida_automatica(msg_lower)
        if resp:
            sess["state"] = STATE_DUVIDAS
            return resp
        sess["state"] = STATE_HUMANO
        logger.info(f"[Dúvidas] Pergunta livre de {nome} ({jid}): {msg[:150]}")
        return RESPONSES["duvidas"]["resposta_livre"]

    # ========== OUTROS ASSUNTOS ==========
    elif sess["state"] == STATE_OUTROS_ASSUNTOS:
        if msg and len(msg) >= 3:
            meta["outros_assuntos_descricao"] = msg
            logger.info(f"[Outros] {nome} ({jid}): {msg[:200]}")
            sess["state"] = STATE_HUMANO
            return "Anotado! ✅ O Dré vai ver sua mensagem e te responder em breve 🤙"
        return "Me conta com mais detalhes o que você precisa!"

    # ========== TRANSBORDO ==========
    elif sess["state"] == STATE_TRANSBORDO:
        sess["state"] = STATE_HUMANO
        return None

    # ========== HUMANO (bot silencia) ==========
    elif sess["state"] == STATE_HUMANO:
        return None

    return RESPONSES["erro_generico"]


# ========== FUNÇÕES EXPORTADAS ==========

def get_session_data(jid: str) -> dict | None:
    if jid in _sessions:
        sess = _sessions[jid]
        return {
            "jid": jid,
            "nome": sess["push_name"],
            "estado": sess["state"],
            "dados": sess["meta"],
            "timestamp": datetime.fromtimestamp(sess["ts"]).isoformat()
        }
    return None
