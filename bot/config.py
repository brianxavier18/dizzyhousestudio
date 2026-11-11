"""
Configurações centralizadas do projeto.
Carrega variáveis de ambiente do arquivo .env (se existir).
"""
import os
import sys
import io
import logging
from dotenv import load_dotenv

# --- Fix de Encoding para Windows (emojis no terminal) ---
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# --- Carregar .env ---
load_dotenv()

# --- Configurações da Evolution API ---
BASE_URL = os.getenv("EVOLUTION_BASE_URL", "http://localhost:8080")
API_KEY = os.getenv("EVOLUTION_API_KEY", "")
INSTANCE_NAME = os.getenv("EVOLUTION_INSTANCE_NAME", "MinhaInstancia")
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")

# IP da máquina local na rede (para o webhook)
LOCAL_IP = os.getenv("LOCAL_IP", "127.0.0.1")
WEBHOOK_PORT = int(os.getenv("WEBHOOK_PORT", "5000"))
WEBHOOK_URL = os.getenv("WEBHOOK_URL", f"http://{LOCAL_IP}:{WEBHOOK_PORT}/webhook")

# --- Cloudflare Workers AI (Transcrição de Áudio via Whisper) ---
CF_WORKER_URL = os.getenv("CF_WORKER_URL", "")
CF_WORKER_AUTH_TOKEN = os.getenv("CF_WORKER_AUTH_TOKEN", "")

# --- Site API (Cloudflare Pages — somente leitura para consultar disponibilidade) ---
SITE_API_URL = os.getenv("SITE_API_URL", "https://dizzyhousestudio.com/api")

# --- Número(s) do Admin (bot NÃO responde a esses números) ---
# Formato: número completo sem + (ex: 5511999999999)
_admin_raw = os.getenv("ADMIN_NUMBERS", "5511999999999")
ADMIN_NUMBERS = set(
    n.strip() for n in _admin_raw.split(",") if n.strip()
)

# --- Headers padrão para requests ---
HEADERS = {
    "apikey": API_KEY,
    "Content-Type": "application/json"
}

# --- Configuração de Logging ---
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

def get_logger(name: str) -> logging.Logger:
    """Retorna um logger configurado com formato padronizado."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        formatter = logging.Formatter(
            '%(asctime)s [%(levelname)s] %(name)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
    return logger
